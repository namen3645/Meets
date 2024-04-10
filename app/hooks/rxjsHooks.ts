import { useEffect, useRef, useState } from 'react'
import type { Observable } from 'rxjs'
import { BehaviorSubject } from 'rxjs'

export function useObservableState<T, U>(
	observable: Observable<T>,
	defaultValue: U
): T | U {
	const [state, setState] = useState<T | U>(defaultValue)

	useEffect(() => {
		const sub = observable.subscribe(setState)
		return () => {
			sub.unsubscribe()
		}
	}, [observable])

	return state
}

export function useObservableEffect<T>(
	observable: Observable<T>,
	fn: (value: T) => void
) {
	const fnRef = useRef(fn)
	fnRef.current = fn
	useEffect(() => {
		const sub = observable.subscribe((v) => fnRef.current(v))
		return () => {
			sub.unsubscribe()
		}
	}, [observable])
}

export function useBehaviorSubject<T>(value: T) {
	const ref = useRef(new BehaviorSubject(value))
	const previousValue = useRef<T>()
	if (previousValue.current !== value) {
		previousValue.current = value
		ref.current.next(value)
	}

	useEffect(() => {
		const { current } = ref
		if (!current) return
		return () => {
			current.complete()
		}
	}, [])

	return ref.current
}
