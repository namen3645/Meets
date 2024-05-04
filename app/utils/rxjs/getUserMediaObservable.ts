import {
	BehaviorSubject,
	Observable,
	combineLatest,
	concat,
	distinctUntilChanged,
	map,
	of,
	switchMap,
} from 'rxjs'
import { getSortedDeviceListObservable } from './getDeviceListObservable'
import { trackIsHealthy } from './trackIsHealthy'

export const DEVICES_EXHAUSTED_ERROR = 'DevicesExhausted'

export function getUserMediaObservable(
	kind: MediaDeviceKind,
	constraints$: Observable<MediaTrackConstraints> = of({}),
	deviceList$: Observable<MediaDeviceInfo[]> = getSortedDeviceListObservable()
): Observable<MediaStreamTrack> {
	// used to restart the track acquisition process when necessary
	const trackId$ = new BehaviorSubject(crypto.randomUUID())
	return combineLatest([
		deviceList$.pipe(
			map((list) => list.filter((d) => d.kind === kind)),
			distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b))
		),
		constraints$,
		trackId$,
	]).pipe(
		// switchMap on the outside here will cause a new
		switchMap(([deviceList, constraints]) =>
			// concat here is going to make these be subscribed
			// to sequentially
			concat(
				...deviceList.map((device) => {
					return new Observable<MediaStreamTrack>((subscribe) => {
						let cleanupRef = { current: () => {} }
						const { deviceId, label } = device
						console.log(`🙏🏻 Requesting ${label}`)
						navigator.mediaDevices
							.getUserMedia(
								kind === 'videoinput'
									? { video: { ...constraints, deviceId } }
									: { audio: { ...constraints, deviceId } }
							)
							.then(async (mediaStream) => {
								const track =
									kind === 'videoinput'
										? mediaStream.getVideoTracks()[0]
										: mediaStream.getAudioTracks()[0]
								if (await trackIsHealthy(track)) {
									const healthCheck = async () => {
										if (document.visibilityState !== 'visible') return
										console.log('Tab is foregrounded, checking health...')

										if (await trackIsHealthy(track)) return
										console.log('Restarting track acquisition')
										trackId$.next(crypto.randomUUID())
									}
									document.addEventListener('visibilitychange', healthCheck)
									cleanupRef.current = () => {
										console.log('🛑 No subscribers, stopping')
										track.stop()
										document.removeEventListener(
											'visibilitychange',
											healthCheck
										)
									}
									subscribe.next(track)
								} else {
									console.log('☠️ track is not healthy, stopping')
									// TODO: Might be problematic to do this here as long
									// as we're depending on an observable of the depriorotized
									// device list
									// addDeviceToDeprioritizeList(device)
									track.stop()
									subscribe.complete()
								}
								track.addEventListener('ended', () => {
									console.log('🔌 Track ended abrubptly')
									subscribe.complete()
								})
							})
							.catch((err) => {
								// this device is in use already, probably on Windows
								// so we can just call this one complete and move on
								if (err instanceof Error && err.name === 'NotReadable') {
									subscribe.complete()
								} else {
									subscribe.error(err)
								}
							})
						return () => {
							cleanupRef.current()
						}
					})
				}),
				new Observable<MediaStreamTrack>((sub) =>
					sub.error(new Error(DEVICES_EXHAUSTED_ERROR))
				)
			)
		)
	)
}
