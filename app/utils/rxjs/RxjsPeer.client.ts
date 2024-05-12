import {
	BehaviorSubject,
	Observable,
	combineLatest,
	distinctUntilChanged,
	filter,
	from,
	fromEvent,
	map,
	of,
	retry,
	share,
	shareReplay,
	switchMap,
	take,
	tap,
	withLatestFrom,
} from 'rxjs'
import invariant from 'tiny-invariant'
import { BulkRequestDispatcher, FIFOScheduler } from '../Peer.utils'
import type {
	RenegotiationResponse,
	TrackObject,
	TracksResponse,
} from '../callsTypes'

interface PeerConfig {
	appId: string
	token: string
	apiBase: string
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
	pushTrackDispatcher = new BulkRequestDispatcher<
		{
			trackName: string
			transceiver: RTCRtpTransceiver
		},
		{ tracks: TrackObject[] }
	>(32)
	pullTrackDispatcher = new BulkRequestDispatcher<
		TrackObject,
		{
			trackMap: Map<
				TrackObject,
				{ resolvedTrack: Promise<MediaStreamTrack>; mid: string }
			>
		}
	>(32)
	closeTrackDispatcher = new BulkRequestDispatcher(32)

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

	#pushTrackInBulk(
		peerConnection: RTCPeerConnection,
		transceiver: RTCRtpTransceiver,
		sessionId: string,
		trackName: string
	): Observable<TrackObject> {
		return new Observable<TrackObject>((subscribe) => {
			console.log('📤 pushing track')
			this.pushTrackDispatcher
				.doBulkRequest({ trackName, transceiver }, (tracks) =>
					this.taskScheduler.schedule(async () => {
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
									tracks: tracks.map(({ trackName, transceiver }) => ({
										trackName,
										mid: transceiver.mid,
										location: 'local',
									})),
								}),
							}
						).then((res) => res.json() as Promise<TracksResponse>)
						invariant(response.tracks !== undefined)
						if (!response.errorCode) {
							await peerConnection.setRemoteDescription(
								new RTCSessionDescription(response.sessionDescription)
							)
						}

						return {
							tracks: response.tracks,
						}
					})
				)
				.then(({ tracks }) => {
					const trackData = tracks.find((t) => t.mid === transceiver.mid)
					if (trackData) {
						subscribe.next({
							...trackData,
							sessionId,
							location: 'remote',
						})
					} else {
						subscribe.error(new Error('Missing TrackData'))
					}
				})
				.catch((err) => subscribe.error(err))

			return () => {
				this.taskScheduler.schedule(async () => {
					console.log('🔚 Closing pushed track')
					return this.closeTrack(peerConnection, transceiver.mid, sessionId)
				})
			}
		})
	}

	pushTrack(track$: Observable<MediaStreamTrack>): Observable<TrackObject> {
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

		return combineLatest([transceiver$, track$]).pipe(
			switchMap(
				([
					{
						stableId,
						transceiver,
						session: { peerConnection, sessionId },
					},
					track,
				]) => {
					if (transceiver.sender.transport !== null) {
						console.log('♻︎ replacing track')
						transceiver.sender.replaceTrack(track)
						return of({
							location: 'remote' as const,
							sessionId,
							trackName: stableId,
						})
					}
					return this.#pushTrackInBulk(
						peerConnection,
						transceiver,
						sessionId,
						stableId
					)
				}
			),
			shareReplay({
				refCount: true,
				bufferSize: 1,
			})
		)
	}

	#pullTrackInBulk(
		peerConnection: RTCPeerConnection,
		sessionId: string,
		trackData: TrackObject
	): Observable<MediaStreamTrack> {
		let mid = ''
		return new Observable((subscribe) => {
			console.log('📥 pulling track')
			this.pullTrackDispatcher
				.doBulkRequest(trackData, (tracks) =>
					this.taskScheduler.schedule(async () => {
						const newTrackResponse: TracksResponse = await fetch(
							`${this.config.apiBase}/${this.config.appId}/sessions/${sessionId}/tracks/new`,
							{
								method: 'POST',
								headers: this.authHeaders(),
								body: JSON.stringify({
									tracks,
								}),
							}
						).then((res) => res.json() as Promise<TracksResponse>)
						if (newTrackResponse.errorCode) {
							throw new Error(newTrackResponse.errorDescription)
						}
						invariant(newTrackResponse.tracks)
						const trackMap = tracks.reduce((acc, track) => {
							const pulledTrackData = newTrackResponse.tracks?.find(
								(t) =>
									t.trackName === track.trackName &&
									t.sessionId === track.sessionId
							)

							if (pulledTrackData && pulledTrackData.mid) {
								acc.set(track, {
									mid: pulledTrackData.mid,
									resolvedTrack: resolveTrack(
										peerConnection,
										(t) => t.mid === pulledTrackData.mid
									),
								})
							}

							return acc
						}, new Map<TrackObject, { resolvedTrack: Promise<MediaStreamTrack>; mid: string }>())

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

						return { trackMap }
					})
				)
				.then(({ trackMap }) => {
					const trackInfo = trackMap.get(trackData)

					if (trackInfo) {
						trackInfo.resolvedTrack
							.then((track) => {
								mid = trackInfo.mid
								subscribe.next(track)
							})
							.catch((err) => subscribe.error(err))
					} else {
						subscribe.error(new Error('Missing Track Info'))
					}
				})
			return () => {
				if (mid) {
					console.log('🔚 Closing pulled track')
					this.taskScheduler.schedule(async () =>
						this.closeTrack(peerConnection, mid, sessionId)
					)
				}
			}
		})
	}

	pullTrack(trackData$: Observable<TrackObject>): Observable<MediaStreamTrack> {
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
				from(this.#pullTrackInBulk(peerConnection, sessionId, trackData))
			)
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

function createPeerConnection(
	configuration: RTCConfiguration = {
		iceServers: [{ urls: 'stun:stun.cloudflare.com:3478' }],
		bundlePolicy: 'max-bundle',
	}
) {
	const pc = new RTCPeerConnection(configuration)

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
