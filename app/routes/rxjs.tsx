import type { ElementRef } from 'react'
import { useMemo, useRef, useState } from 'react'
import { Observable, map, shareReplay } from 'rxjs'
import { useObservableEffect, useObservableState } from '~/hooks/rxjsHooks'
import { useIsServer } from '~/hooks/useIsServer'
import { RxjsPeer } from '~/utils/rxjs/RxjsPeer.client'
import { getUserMediaObservable } from '~/utils/rxjs/getUserMediaObservable'

export default function Component() {
	const isServer = useIsServer()
	if (isServer) return null
	return <Rxjs />
}

function Rxjs() {
	const [localFeedOn, setLocalFeedOn] = useState(true)
	const [remoteFeedOn, setRemoteFeedOn] = useState(false)
	const client = useMemo(
		() =>
			new RxjsPeer({
				apiBase: `https://rtc.live.cloudflare.com/v1/apps`,
				appId: 'eaa164454bfb6fa906161c40c87b4389',
				token:
					'0d90a3b43ee0a2d2c0c38c0612139113ecf9027d67fa8f0ccf82234ee729a5df',
			}),
		[]
	)

	const peerConnectionState = useObservableState(
		client.peerConnectionState$,
		'new'
	)
	const sessionId = useObservableState(
		client.session$.pipe(map((x) => (x ? x.sessionId : null))),
		null
	)

	const webcamTrack$ = useWebcam(localFeedOn)
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

function useWebcam(enabled: boolean) {
	return useMemo(() => {
		if (!enabled) return null
		return getUserMediaObservable('videoinput').pipe(
			shareReplay({
				refCount: true,
				bufferSize: 1,
			})
		)
	}, [enabled])
}
