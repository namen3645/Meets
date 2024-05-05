import {
	BehaviorSubject,
	Observable,
	combineLatest,
	distinctUntilChanged,
	filter,
	finalize,
	from,
	fromEvent,
	map,
	retry,
	share,
	shareReplay,
	switchMap,
	take,
	tap,
	withLatestFrom,
} from 'rxjs'
import invariant from 'tiny-invariant'
import { FIFOScheduler } from '../Peer.utils'
import type { RenegotiationResponse, TracksResponse } from '../callsTypes'

// TODO: make these API calls through the constructor's request API

interface PeerConfig {
	appId: string
	token: string
	apiBase: string
}

interface TrackData {
	location: string
	sessionId: string
	trackName: string
}

export class RxjsPeer {
	#peerConnection: BehaviorSubject<RTCPeerConnection>
	peerConnection$: Observable<RTCPeerConnection>
	session$: Observable<{
		peerConnection: RTCPeerConnection
		sessionId: string
	}>
	peerConnectionState$: Observable<RTCPeerConnectionState>
	config: PeerConfig

	authHeaders() {
		return {
			Authorization: `Bearer ${this.config.token}`,
		}
	}

	constructor(config: PeerConfig) {
		this.config = config
		this.#peerConnection = new BehaviorSubject(createPeerConnection())
		this.peerConnection$ = this.#peerConnection.asObservable()
		this.session$ = this.peerConnection$.pipe(
			switchMap((pc) => from(this.createSession(pc))),
			retry(),
			// we want new subscribers to receive the session right away
			shareReplay({
				bufferSize: 1,
				refCount: true,
			})
		)

		this.peerConnectionState$ = this.session$.pipe(
			switchMap(({ peerConnection }) =>
				fromEvent(
					peerConnection,
					'connectionstatechange',
					() => peerConnection.connectionState
				)
			),
			tap((connectionState) => {
				if (connectionState === 'failed' || connectionState === 'closed') {
					this.#peerConnection.next(createPeerConnection())
				}
			}),
			share()
		)

		// TODO: Remove this
		const explode = () => {
			console.log('💥 Closing connection')
			this.#peerConnection.value.close()
			this.#peerConnection.value.dispatchEvent(
				new Event('connectionstatechange')
			)
		}

		Object.assign(window, { explode })
	}

	taskScheduler = new FIFOScheduler()

	async createSession(peerConnection: RTCPeerConnection) {
		console.log('🆕 creating new session')
		const { appId, apiBase, token } = this.config
		// create an offer and set it as the local description
		await peerConnection.setLocalDescription(await peerConnection.createOffer())
		const { sessionId, sessionDescription } = await fetch(
			`${apiBase}/${appId}/sessions/new`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${token}`,
				},
				body: JSON.stringify({
					sessionDescription: peerConnection.localDescription,
				}),
			}
		).then((res) => res.json() as any)
		const connected = new Promise((res, rej) => {
			// timeout after 5s
			setTimeout(rej, 5000)
			const iceConnectionStateChangeHandler = () => {
				if (peerConnection.iceConnectionState === 'connected') {
					peerConnection.removeEventListener(
						'iceconnectionstatechange',
						iceConnectionStateChangeHandler
					)
					res(undefined)
				}
			}
			peerConnection.addEventListener(
				'iceconnectionstatechange',
				iceConnectionStateChangeHandler
			)
		})

		// Once both local and remote descriptions are set, the ICE process begins
		await peerConnection.setRemoteDescription(sessionDescription)
		// Wait until the peer connection's iceConnectionState is "connected"
		await connected
		return { peerConnection, sessionId }
	}

	pushTrack(track$: Observable<MediaStreamTrack>): Observable<TrackData> {
		// we want a single id for this connection, so we will use the
		// first track's id
		const stableId$ = track$.pipe(
			take(1),
			map((t) => t.id)
		)
		const transceiver$ = combineLatest([stableId$, this.session$]).pipe(
			withLatestFrom(track$),
			map(([[stableId, session], track]) => {
				console.log('🌱 creating transceiver!')
				return {
					transceiver: session.peerConnection.addTransceiver(track, {
						direction: 'sendonly',
					}),
					stableId,
					session,
				}
			})
		)

		let completeRef = { current: async () => {} }
		return combineLatest([transceiver$, track$]).pipe(
			tap(([{ session, transceiver }]) => {
				completeRef.current = () =>
					this.taskScheduler.schedule(async () => {
						return this.closeTrack(
							session.peerConnection,
							transceiver.mid,
							session.sessionId
						)
					})
			}),
			switchMap(
				([
					{
						stableId,
						transceiver,
						session: { peerConnection, sessionId },
					},
					track,
				]) =>
					from(
						this.taskScheduler.schedule(async () => {
							if (transceiver.sender.transport !== null) {
								console.log('♻︎ replacing track')
								transceiver.sender.replaceTrack(track)
								return {
									location: 'remote',
									sessionId,
									trackName: stableId,
								}
							}
							console.log('📤 pushing track')
							await peerConnection.setLocalDescription(
								await peerConnection.createOffer()
							)

							const response = await fetch(
								`${this.config.apiBase}/${this.config.appId}/sessions/${sessionId}/tracks/new`,
								{
									method: 'POST',
									headers: this.authHeaders(),
									body: JSON.stringify({
										sessionDescription: {
											sdp: peerConnection.localDescription?.sdp,
											type: 'offer',
										},
										tracks: [
											{
												location: 'local',
												mid: transceiver.mid,
												trackName: stableId,
											},
										],
									}),
								}
							).then((res) => res.json() as Promise<TracksResponse>)
							if (!response.errorCode) {
								await peerConnection.setRemoteDescription(
									new RTCSessionDescription(response.sessionDescription)
								)
							}
							return {
								location: 'remote',
								sessionId,
								trackName: stableId,
							}
						})
					)
			),
			finalize(() => {
				completeRef.current()
			}),
			shareReplay({
				refCount: true,
				bufferSize: 1,
			})
		)
	}

	pullTrack(trackData$: Observable<TrackData>): Observable<MediaStreamTrack> {
		let closeRef = { current: () => {} }
		return combineLatest([
			this.session$,
			trackData$.pipe(
				// only necessary when pulling a track that was pushed locally to avoid
				// re-pulling when pushed track transceiver replaces track
				distinctUntilChanged((x, y) => JSON.stringify(x) === JSON.stringify(y))
			),
		]).pipe(
			// avoid re-pulling if track data changed before connection state is connected
			// should only really be necessary if pulling a track that was pushed locally
			filter(
				([{ peerConnection }]) => peerConnection.connectionState === 'connected'
			),
			switchMap(([{ peerConnection, sessionId }, trackData]) =>
				from(
					this.taskScheduler.schedule(async () => {
						console.log('📥 Pulling track!')
						const newTrackResponse = await fetch(
							`${this.config.apiBase}/${this.config.appId}/sessions/${sessionId}/tracks/new`,
							{
								method: 'POST',
								headers: this.authHeaders(),
								body: JSON.stringify({
									tracks: [trackData],
								}),
							}
						).then((res) => res.json() as Promise<TracksResponse>)

						const mid = newTrackResponse?.tracks?.[0].mid ?? undefined
						invariant(mid)
						const resolvedTrack = resolveTrack(
							peerConnection,
							(t) => t.mid === mid
						)
						invariant(resolveTrack)
						closeRef.current = () => {
							this.taskScheduler.schedule(async () => {
								return this.closeTrack(peerConnection, mid, sessionId)
							})
						}

						if (newTrackResponse.requiresImmediateRenegotiation) {
							await peerConnection.setRemoteDescription(
								new RTCSessionDescription(newTrackResponse.sessionDescription)
							)
							const answer = await peerConnection.createAnswer()
							await peerConnection.setLocalDescription(answer)

							const renegotiationResponse = await fetch(
								`${this.config.apiBase}/${this.config.appId}/sessions/${sessionId}/renegotiate`,
								{
									method: 'PUT',
									body: JSON.stringify({
										sessionDescription: {
											type: 'answer',
											sdp: peerConnection.currentLocalDescription?.sdp,
										},
									}),
									headers: this.authHeaders(),
								}
							).then((res) => res.json() as Promise<RenegotiationResponse>)
							if (renegotiationResponse.errorCode)
								throw new Error(renegotiationResponse.errorDescription)
						}
						return resolvedTrack
					})
				)
			),
			finalize(() => closeRef.current())
		)
	}

	async closeTrack(
		peerConnection: RTCPeerConnection,
		mid: string | null,
		sessionId: string
	) {
		const { appId, token, apiBase } = this.config
		const transceiver = peerConnection
			.getTransceivers()
			.find((t) => t.mid === mid)
		if (
			peerConnection.connectionState !== 'connected' ||
			transceiver === undefined
		) {
			return
		}
		console.log('🔚 closing track')
		transceiver.direction = 'inactive'
		await peerConnection.setLocalDescription(await peerConnection.createOffer())
		const requestBody = {
			tracks: [{ mid: transceiver.mid }],
			sessionDescription: {
				sdp: peerConnection.localDescription?.sdp,
				type: 'offer',
			},
			force: false,
		}
		const response = await fetch(
			`${apiBase}/${appId}/sessions/${sessionId}/tracks/close`,
			{
				method: 'PUT',
				body: JSON.stringify(requestBody),
				headers: {
					Authorization: `Bearer ${token}`,
				},
			}
		).then((res) => res.json() as Promise<TracksResponse>)
		await peerConnection.setRemoteDescription(
			new RTCSessionDescription(response.sessionDescription)
		)
	}

	destroy() {
		this.#peerConnection.getValue().close()
	}
}

function createPeerConnection() {
	const pc = new RTCPeerConnection({
		iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
		bundlePolicy: 'max-bundle',
	})

	pc.addTransceiver('audio', {
		direction: 'inactive',
	})

	return pc
}

async function resolveTrack(
	peerConnection: RTCPeerConnection,
	compare: (t: RTCRtpTransceiver) => boolean,
	timeout = 5000
) {
	return new Promise<MediaStreamTrack>((resolve, reject) => {
		setTimeout(reject, timeout)
		const handler = () => {
			const transceiver = peerConnection.getTransceivers().find(compare)
			if (transceiver) {
				resolve(transceiver.receiver.track)
				peerConnection.removeEventListener('track', handler)
			}
		}

		peerConnection.addEventListener('track', handler)
	})
}
