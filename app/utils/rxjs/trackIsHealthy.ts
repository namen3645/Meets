export async function trackIsHealthy(
	track: MediaStreamTrack
): Promise<boolean> {
	console.log(`👩🏻‍⚕️ Checking track health...`)
	// TODO:
	// if (track.kind === "audio") {
	//   test audio stream with web audio api
	// }
	// if (track.kind === "video") {
	//   draw to canvas and check if all black pixels
	// }
	//

	const randomFailure = Math.random() < 0.2

	if (randomFailure) {
		console.log('Random failure!')
	}

	const healthy =
		!track.muted &&
		track.readyState === 'live' &&
		track.enabled &&
		!randomFailure
	console.log(`👩🏻‍⚕️ track is ${healthy ? 'healthy' : 'unhealthy'}!`)
	return healthy
}
