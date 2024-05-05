import type { ComponentProps, ElementRef } from 'react'
import { useMemo, useRef, useState } from 'react'
import { Observable, map, shareReplay } from 'rxjs'
import { useObservableEffect, useObservableState } from '~/hooks/rxjsHooks'
import { useIsServer } from '~/hooks/useIsServer'
import { RxjsPeer } from '~/utils/rxjs/RxjsPeer.client'
import { getUserMediaTrack$ } from '~/utils/rxjs/getUserMediaTrack$'

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
		client.session$.pipe(map((x) => x.sessionId)),
		null
	)

	const localVideoTrack$ = useWebcamTrack$(localFeedOn)
	const removeVideoTrack$ = useMemo(() => {
		if (!localVideoTrack$ || !remoteFeedOn) return null
		return client.pullTrack(client.pushTrack(localVideoTrack$))
	}, [client, remoteFeedOn, localVideoTrack$])

	return (
		<div className="p-2 flex flex-col gap-3">
			<div className="flex gap-2">
				<Button onClick={() => setLocalFeedOn(!localFeedOn)}>
					Turn Local {localFeedOn ? 'Off' : 'On'}
				</Button>
				<Button onClick={() => setRemoteFeedOn(!remoteFeedOn)}>
					Turn Remote {remoteFeedOn ? 'Off' : 'On'}
				</Button>
			</div>
			<div className="grid xl:grid-cols-2">
				{localVideoTrack$ && localFeedOn && (
					<Video videoTrack$={localVideoTrack$} />
				)}
				{removeVideoTrack$ && remoteFeedOn && (
					<Video videoTrack$={removeVideoTrack$} />
				)}
			</div>
			<pre>{JSON.stringify({ peerConnectionState, sessionId }, null, 2)}</pre>
		</div>
	)
}

function Button(props: ComponentProps<'button'>) {
	return <button className="border px-1" {...props}></button>
}

function Video(props: { videoTrack$: Observable<MediaStreamTrack | null> }) {
	const ref = useRef<ElementRef<'video'>>(null)
	useObservableEffect(props.videoTrack$, (track) => {
		if (!ref.current) return
		if (track) {
			const mediaStream = new MediaStream()
			mediaStream.addTrack(track)
			ref.current.srcObject = mediaStream
		} else {
			ref.current.srcObject = null
		}
	})

	return (
		<video className="h-full w-full" ref={ref} autoPlay muted playsInline />
	)
}

function useWebcamTrack$(enabled: boolean) {
	return useMemo(() => {
		if (!enabled) return null
		return getUserMediaTrack$('videoinput').pipe(
			shareReplay({
				refCount: true,
				bufferSize: 1,
			})
		)
	}, [enabled])
}
