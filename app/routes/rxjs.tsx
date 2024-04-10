import type { ElementRef } from 'react'
import { useEffect, useMemo, useRef, useState } from 'react'
import {
	BehaviorSubject,
	Observable,
	combineLatest,
	debounceTime,
	distinctUntilChanged,
	filter,
	finalize,
	from,
	fromEvent,
	map,
	merge,
	retry,
	share,
	shareReplay,
	switchMap,
	take,
	tap,
	withLatestFrom,
} from 'rxjs'
import invariant from 'tiny-invariant'
import {
	useBehaviorSubject,
	useObservableEffect,
	useObservableState,
} from '~/hooks/rxjsHooks'
import { useIsServer } from '~/hooks/useIsServer'
import { FIFOScheduler } from '~/utils/Peer.utils'
import type { RenegotiationResponse, TracksResponse } from '~/utils/callsTypes'

function debug<T>(message: string) {
	return tap<T>({
		next: (...args) => console.log(message, ...args),
		complete: () => console.log('COMPLETED ', message),
	})
}

export default function Component() {
	const isServer = useIsServer()
	if (isServer) return null

	return <Rxjs />
}

function Rxjs() {
	const client = useMemo(
		() =>
			new RxjsPeerClient({
				appId: 'eaa164454bfb6fa906161c40c87b4389',
				token:
					'0d90a3b43ee0a2d2c0c38c0612139113ecf9027d67fa8f0ccf82234ee729a5df',
			}),
		[]
	)

	const peerConnection = useObservableState(client.peerConnection$, null)
	const peerConnectionState = useObservableState(
		client.peerConnectionState$,
		'new'
	)
	const sessionId = useObservableState(
		client.session$.pipe(map((x) => (x ? x.sessionId : null))),
		null
	)
	const [localFeedOn, setLocalFeedOn] = useState(true)
	const [remoteFeedOn, setRemoteFeedOn] = useState(false)
	const webcamTrack$ = useWebcam(
		localFeedOn,
		'fd68098a2104aa925d8465ca52dd76fa2d4214679a63ee2c3befa0017855c843'
	)

	useEffect(() => {
		const explode = () => {
			console.log('💥 Closing connection')
			peerConnection?.close()
			peerConnection?.dispatchEvent(new Event('connectionstatechange'))
		}

		Object.assign(window, { explode })

		// const i = setInterval(explode, 5e3)
		// return () => {
		// 	clearInterval(i)
		// }
	}, [peerConnection])

	const remoteTrack$ = useMemo(() => {
		if (!webcamTrack$ || !remoteFeedOn) return null
		return client.pullTrack(client.pushTrack(webcamTrack$))
	}, [client, remoteFeedOn, webcamTrack$])

	return (
		<div>
			<button className="border" onClick={() => setLocalFeedOn(!localFeedOn)}>
				{' '}
				turn local {localFeedOn ? 'off' : 'on'}{' '}
			</button>
			<button className="border" onClick={() => setRemoteFeedOn(!remoteFeedOn)}>
				{' '}
				turn remote {remoteFeedOn ? 'off' : 'on'}{' '}
			</button>
			{webcamTrack$ && localFeedOn && <Video videoTrack$={webcamTrack$} />}
			{remoteTrack$ && remoteFeedOn && <Video videoTrack$={remoteTrack$} />}

			<pre>
				{JSON.stringify(
					{
						peerConnectionState,
						sessionId,
					},
					null,
					2
				)}
			</pre>
		</div>
	)
}

function Video(props: { videoTrack$: Observable<MediaStreamTrack | null> }) {
	const ref = useRef<ElementRef<'video'>>(null)
	useObservableEffect(props.videoTrack$, (track) => {
		if (track && ref.current) {
			const mediaStream = new MediaStream()
			mediaStream.addTrack(track)
			ref.current.srcObject = mediaStream
		}
	})

	return <video ref={ref} autoPlay muted playsInline />
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

const API_BASE = `https://rtc.live.cloudflare.com/v1/apps`

async function createSession(
	peerConnection: RTCPeerConnection,
	config: { appId: string; token: string }
) {
	console.log('🆕 creating new session')
	// create an offer and set it as the local description
	await peerConnection.setLocalDescription(await peerConnection.createOffer())
	const { sessionId, sessionDescription } = await fetch(
		`${API_BASE}/${config.appId}/sessions/new`,
		{
			method: 'POST',
			headers: {
				Authorization: `Bearer ${config.token}`,
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

interface AuthData {
	appId: string
	token: string
}

interface TrackData {
	location: string
	sessionId: string
	trackName: string
}

class RxjsPeerClient {
	#peerConnection: BehaviorSubject<RTCPeerConnection>
	peerConnection$: Observable<RTCPeerConnection>
	session$: Observable<{
		peerConnection: RTCPeerConnection
		sessionId: string
	}>
	peerConnectionState$: Observable<RTCPeerConnectionState>
	authData: AuthData

	authHeaders() {
		return {
			Authorization: `Bearer ${this.authData.token}`,
		}
	}

	constructor(config: AuthData) {
		this.authData = config
		this.#peerConnection = new BehaviorSubject(createPeerConnection())
		this.peerConnection$ = this.#peerConnection.asObservable()
		this.session$ = this.peerConnection$.pipe(
			switchMap((pc) => from(createSession(pc, config))),
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
	}

	taskScheduler = new FIFOScheduler()

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
						return closeTrack(
							session.peerConnection,
							transceiver.mid,
							session.sessionId,
							this.authData
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
								`${API_BASE}/${this.authData.appId}/sessions/${sessionId}/tracks/new`,
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
							`${API_BASE}/${this.authData.appId}/sessions/${sessionId}/tracks/new`,
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
								return closeTrack(peerConnection, mid, sessionId, this.authData)
							})
						}

						if (newTrackResponse.requiresImmediateRenegotiation) {
							await peerConnection.setRemoteDescription(
								new RTCSessionDescription(newTrackResponse.sessionDescription)
							)
							const answer = await peerConnection.createAnswer()
							await peerConnection.setLocalDescription(answer)

							const renegotiationResponse = await fetch(
								`${API_BASE}/${this.authData.appId}/sessions/${sessionId}/renegotiate`,
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

	destroy() {
		this.#peerConnection.getValue().close()
	}
}

function getDevices$() {
	return merge(
		navigator.mediaDevices.enumerateDevices(),
		fromEvent(navigator.mediaDevices, 'devicechange').pipe(
			debounceTime(1500),
			switchMap(() => navigator.mediaDevices.enumerateDevices())
		)
	)
}

function useWebcam(enabled: boolean, deviceId?: string) {
	// stable reference to the observable
	const deviceId$ = useBehaviorSubject(deviceId)
	return useMemo(() => {
		if (!enabled) return null
		return combineLatest([deviceId$, getDevices$()]).pipe(
			switchMap(
				([deviceId]) =>
					new Observable<MediaStreamTrack>((sub) => {
						let track: MediaStreamTrack
						const getTrack = async () => {
							console.log('📹 requesting webcam')
							navigator.mediaDevices
								.getUserMedia({ video: { deviceId } })
								.then((mediaStream) => {
									const [t] = mediaStream.getVideoTracks()
									t.addEventListener('ended', () => {
										console.log('🔌 webcam stopped abruptly')
										if (!sub.closed) {
											getTrack()
										}
									})
									sub.next(t)
									track = t
									// we need this check because the promise may have resolved
									// after the last subscriber has already unsubscribed, meaning
									// the cleanup function has already run
									if (sub.closed) {
										console.log('🛑 stopping webcam intentionally')
										track.stop()
									}
									return mediaStream
								})
						}
						getTrack()
						return () => {
							console.log('🛑 stopping webcam intentionally')
							track?.stop()
						}
					})
			),
			shareReplay({
				refCount: true,
				bufferSize: 1,
			})
		)
	}, [enabled, deviceId$])
}

async function closeTrack(
	peerConnection: RTCPeerConnection,
	mid: string | null,
	sessionId: string,
	{ appId, token }: AuthData
) {
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
		`${API_BASE}/${appId}/sessions/${sessionId}/tracks/close`,
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
