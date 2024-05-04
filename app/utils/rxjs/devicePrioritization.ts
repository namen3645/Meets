import { Observable, filter, fromEvent, map, merge, of } from 'rxjs'
import invariant from 'tiny-invariant'

export interface GetDeviceListOptions {
	prioritizeList?: Array<Partial<MediaDeviceInfo>>
	deprioritizeList?: Array<Partial<MediaDeviceInfo>>
}

export const sortMediaDeviceInfo =
	(options: GetDeviceListOptions) =>
	(a: MediaDeviceInfo, b: MediaDeviceInfo) => {
		const { prioritizeList = [], deprioritizeList = [] } = options
		const priorityA = prioritizeList.findIndex(
			(item) => item.deviceId === a.deviceId || item.label === a.label
		)
		const priorityB = prioritizeList.findIndex(
			(item) => item.deviceId === b.deviceId || item.label === b.label
		)

		// both are in the prioritizeList,
		// compare indicies to sort
		if (priorityA !== -1 && priorityB !== -1) {
			return priorityA - priorityB
		} else if (priorityA !== -1) {
			return -1
		} else if (priorityB !== -1) {
			return 1
		}

		if (b.label.toLowerCase().includes('virtual')) {
			return -1
		}

		if (b.label.toLowerCase().includes('iphone microphone')) {
			return -1
		}

		const deprioritizeA = deprioritizeList.some(
			(item) => item.deviceId === a.deviceId || item.label === a.label
		)
		const deprioritizeB = deprioritizeList.some(
			(item) => item.deviceId === b.deviceId || item.label === b.label
		)

		if (deprioritizeA && !deprioritizeB) {
			// move A down the list
			return 1
		} else if (!deprioritizeA && deprioritizeB) {
			// move B down the list
			return -1
		}

		// leave as is
		return 0
	}

const PRIORITIZED_DEVICE_LIST = 'PRIORITIZED_DEVICE_LIST'
const DEPRIORITIZED_DEVICE_LIST = 'DEPRIORITIZED_DEVICE_LIST'

export function getPrioritizationList(): Array<Partial<MediaDeviceInfo>> {
	const values = localStorage.getItem(PRIORITIZED_DEVICE_LIST)
	if (values === null) return []
	return JSON.parse(values)
}

export function prependDeviceToPrioritizeList(
	device: Partial<MediaDeviceInfo>
) {
	removeDeviceFromPrioritizeList(device)
	removeDeviceFromDeprioritizeList(device)
	localStorage.setItem(
		PRIORITIZED_DEVICE_LIST,
		JSON.stringify([device, ...getPrioritizationList()])
	)
}

export function removeDeviceFromPrioritizeList(
	device: Partial<MediaDeviceInfo>
) {
	localStorage.setItem(
		PRIORITIZED_DEVICE_LIST,
		JSON.stringify(
			getPrioritizationList().filter(
				(v) => v.label !== device.label && v.deviceId !== device.deviceId
			)
		)
	)
}

export function getDeprioritizationList(): Array<Partial<MediaDeviceInfo>> {
	const values = localStorage.getItem(DEPRIORITIZED_DEVICE_LIST)
	if (values === null) return []
	return JSON.parse(values)
}

export function addDeviceToDeprioritizeList(device: Partial<MediaDeviceInfo>) {
	localStorage.setItem(
		DEPRIORITIZED_DEVICE_LIST,
		JSON.stringify([...getDeprioritizationList(), device])
	)
}

export function removeDeviceFromDeprioritizeList(
	device: Partial<MediaDeviceInfo>
) {
	localStorage.setItem(
		DEPRIORITIZED_DEVICE_LIST,
		JSON.stringify(
			getDeprioritizationList().filter(
				(v) => v.label === device.label || v.deviceId === device.deviceId
			)
		)
	)
}

export function getPrioritizedDeviceListObservable(): Observable<
	Partial<MediaDeviceInfo>[]
> {
	return merge(
		of(getPrioritizationList()),
		localStorageValueObservable(PRIORITIZED_DEVICE_LIST).pipe(
			map((value) => {
				invariant(value !== null)
				return JSON.parse(value) as Array<Partial<MediaDeviceInfo>>
			})
		)
	)
}

export function getDeprioritizedDeviceListObservable() {
	return merge(
		of(getDeprioritizationList()),
		localStorageValueObservable(PRIORITIZED_DEVICE_LIST).pipe(
			map((value) => {
				invariant(value !== null)
				return JSON.parse(value) as Array<Partial<MediaDeviceInfo>>
			})
		)
	)
}

function localStorageValueObservable(key: string) {
	return fromEvent(window, 'storage').pipe(
		filter((e) => {
			invariant(e instanceof StorageEvent)
			return e.key === key
		}),
		map((e) => {
			invariant(e instanceof StorageEvent)
			return e.newValue
		})
	)
}

if (typeof window !== 'undefined') {
	Object.assign(window, {
		prependDeviceToPrioritizeList,
		addDeviceToDeprioritizeList,
		removeDeviceFromPrioritizeList,
		removeDeviceFromDeprioritizeList,
	})
}
