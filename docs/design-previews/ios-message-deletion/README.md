# iOS message deletion particle validation

These images show physical-iPhone captures of offline preview fixtures at source commit `1f9cadc3e`, before the integration rebase. Embedded screenshot metadata has been removed without changing image pixels.

- [text-particles.png](../../../.github/assets/ios-message-deletion/text-particles.png): the text message is dissolving while its neighbors reflow.
- [photo-particles.png](../../../.github/assets/ios-message-deletion/photo-particles.png): the photo message is dissolving without an opaque wallpaper rectangle.

The device run passed 13 focused regression checks and 3 UI/performance tests. The performance test recorded zero hitches in each of its three measured text deletions. These results cover the Beta preview flow, not backend-connected deletion or a production release.
