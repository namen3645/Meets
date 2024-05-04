import {
	combineLatest,
	debounceTime,
	fromEvent,
	map,
	merge,
	switchMap,
} from 'rxjs'
import {
	getDeprioritizedDeviceListObservable,
	getPrioritizedDeviceListObservable,
	sortMediaDeviceInfo,
} from './devicePrioritization'

export function getDeviceListObservable() {
	return merge(
		navigator.mediaDevices.enumerateDevices(),
		fromEvent(navigator.mediaDevices, 'devicechange').pipe(
			debounceTime(1500),
			switchMap(() => navigator.mediaDevices.enumerateDevices())
		)
	)
}

export function getSortedDeviceListObservable() {
	return combineLatest([
		getDeviceListObservable(),
		getPrioritizedDeviceListObservable(),
		getDeprioritizedDeviceListObservable(),
	]).pipe(
		map(([devices, prioritizeList, deprioritizeList]) =>
			devices.sort(
				sortMediaDeviceInfo({
					prioritizeList,
					deprioritizeList,
				})
			)
		)
	)
}
