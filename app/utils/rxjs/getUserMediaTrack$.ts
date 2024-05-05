import {
	Observable,
	Subscriber,
	combineLatest,
	concat,
	distinctUntilChanged,
	map,
	of,
	switchMap,
} from 'rxjs'
import {
	addDeviceToDeprioritizeList,
	removeDeviceFromDeprioritizeList,
} from './devicePrioritization'
import { getSortedDeviceListObservable } from './getDeviceListObservable'
import { trackIsHealthy } from './trackIsHealthy'

export const DEVICES_EXHAUSTED_ERROR = 'DevicesExhausted'

export function getUserMediaTrack$(
	kind: MediaDeviceKind,
	constraints$: Observable<MediaTrackConstraints> = of({}),
	deviceList$: Observable<MediaDeviceInfo[]> = getSortedDeviceListObservable()
): Observable<MediaStreamTrack> {
	return combineLatest([
		deviceList$.pipe(
			map((list) => list.filter((d) => d.kind === kind)),
			distinctUntilChanged((a, b) => JSON.stringify(a) === JSON.stringify(b))
		),
		constraints$,
	]).pipe(
		// switchMap on the outside here will cause a new
		switchMap(([deviceList, constraints]) =>
			// concat here is going to make these be subscribed
			// to sequentially
			concat(
				...deviceList.map((device) => {
					return new Observable<MediaStreamTrack>((subscriber) => {
						const cleanupRef = { current: () => {} }
						acquireTrack(subscriber, device, kind, constraints, cleanupRef)
						return () => {
							console.log('🛑 Errored or no subscribers, stopping...')
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

function acquireTrack(
	subscriber: Subscriber<MediaStreamTrack>,
	device: MediaDeviceInfo,
	kind: MediaDeviceKind,
	constraints: MediaTrackConstraints,
	cleanupRef: { current: () => void }
) {
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
				const cleanup = () => {
					console.log('Cleaning up...')
					track.stop()
					document.removeEventListener('visibilitychange', onVisibleHandler)
				}
				const onVisibleHandler = async () => {
					if (document.visibilityState !== 'visible') return
					console.log('Tab is foregrounded, checking health...')
					if (await trackIsHealthy(track)) return
					console.log('Reacquiring track')
					cleanup()
					acquireTrack(subscriber, device, kind, constraints, cleanupRef)
				}
				document.addEventListener('visibilitychange', onVisibleHandler)
				cleanupRef.current = cleanup
				subscriber.next(track)
				removeDeviceFromDeprioritizeList(device)
			} else {
				console.log('☠️ track is not healthy, stopping')
				addDeviceToDeprioritizeList(device)
				track.stop()
				subscriber.complete()
			}
			track.addEventListener('ended', () => {
				console.log('🔌 Track ended abrubptly')
				subscriber.complete()
			})
		})
		.catch((err) => {
			// this device is in use already, probably on Windows
			// so we can just call this one complete and move on
			if (err instanceof Error && err.name === 'NotReadable') {
				subscriber.complete()
			} else {
				subscriber.error(err)
			}
		})
}
