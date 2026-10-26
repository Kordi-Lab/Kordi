import BackgroundTasks
import CoreLocation
import UIKit

/// Background work for Nearby: significant changes, the region around the
/// last point, the refresh task, one-off fixes and the delegate callbacks.
/// iOS decides when any of these run; a force-quit app gets none of them.
extension CommonGroundNearbyLocator {
    /// Starts or stops background work to match the state and access.
    func applyBackgroundMode() {
        guard let manager else { return }
        guard backgroundAllowed else { return stopBackground() }
        if CLLocationManager.significantLocationChangeMonitoringAvailable() {
            manager.startMonitoringSignificantLocationChanges()
        }
        if let latitude = state?.lastLatitude, let longitude = state?.lastLongitude {
            placeRegion(around: CLLocationCoordinate2D(latitude: latitude, longitude: longitude))
        }
        scheduleRefresh()
    }

    func stopBackground() {
        guard let manager else { return }
        manager.stopMonitoringSignificantLocationChanges()
        for region in manager.monitoredRegions where region.identifier == Self.regionID {
            manager.stopMonitoring(for: region)
        }
        BGTaskScheduler.shared.cancel(taskRequestWithIdentifier: Self.refreshTaskID)
    }

    /// One 200 m region around the last posted point; leaving it sends a new
    /// point and moves the region there. The same identifier replaces the old one.
    func placeRegion(around center: CLLocationCoordinate2D) {
        guard let manager, CLLocationManager.isMonitoringAvailable(for: CLCircularRegion.self) else { return }
        let radius = min(Self.regionRadius, manager.maximumRegionMonitoringDistance)
        let region = CLCircularRegion(center: center, radius: radius, identifier: Self.regionID)
        region.notifyOnEntry = false
        region.notifyOnExit = true
        manager.startMonitoring(for: region)
    }

    // MARK: Refresh task

    func registerRefreshTask() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: Self.refreshTaskID, using: nil) { task in
            Task { @MainActor in CommonGroundNearbyLocator.shared.runRefresh(task) }
        }
    }

    func scheduleRefresh() {
        let request = BGAppRefreshTaskRequest(identifier: Self.refreshTaskID)
        request.earliestBeginDate = Date().addingTimeInterval(Self.refreshInterval)
        // Fails on the Simulator and when Background App Refresh is off.
        try? BGTaskScheduler.shared.submit(request)
    }

    /// iOS granted background time: one fix, one post, and the next request.
    func runRefresh(_ task: BGTask) {
        guard backgroundAllowed else {
            task.setTaskCompleted(success: true)
            return
        }
        scheduleRefresh()
        finishRefresh(success: false)
        pendingRefresh = task
        let work = Task { @MainActor in
            let fix = await oneFix(timeout: 20)
            if let fix { await consider(fix) }
            finishRefresh(success: fix != nil)
        }
        task.expirationHandler = {
            Task { @MainActor in
                work.cancel()
                CommonGroundNearbyLocator.shared.finishRefresh(success: false)
            }
        }
    }

    /// Completes the open refresh task once.
    func finishRefresh(success: Bool) {
        pendingRefresh?.setTaskCompleted(success: success)
        pendingRefresh = nil
    }

    // MARK: One fix

    /// Asks for one location and waits for it, or nil after `timeout` seconds.
    func oneFix(timeout: TimeInterval) async -> CLLocation? {
        guard let manager else { return nil }
        let key = UUID()
        return await withCheckedContinuation { continuation in
            fixWaiters[key] = continuation
            manager.requestLocation()
            Task { @MainActor [weak self] in
                try? await Task.sleep(for: .seconds(timeout))
                self?.fixWaiters.removeValue(forKey: key)?.resume(returning: nil)
            }
        }
    }

    func resolveFixWaiters(_ location: CLLocation?) {
        let waiters = fixWaiters.values
        fixWaiters = [:]
        waiters.forEach { $0.resume(returning: location) }
    }

    // MARK: Delegate events, on the main thread

    func received(_ locations: [CLLocation]) {
        guard let location = locations.last else { return }
        resolveFixWaiters(location)
        if foreground, !updating, let manager {
            manager.startUpdatingLocation()
            updating = true
        }
        if !updatingNow { Task { await consider(location) } }
    }

    func failed(_ error: Error) {
        resolveFixWaiters(nil)
        // A screen still showing keeps trying with standard updates.
        if foreground, !updating, let manager, access.granted {
            manager.startUpdatingLocation()
            updating = true
        }
    }

    func exited(_ region: CLRegion) {
        guard region.identifier == Self.regionID, backgroundAllowed else { return }
        let time = beginBackgroundTime()
        Task {
            if let fix = await oneFix(timeout: 15) { await consider(fix) }
            endBackgroundTime(time)
        }
    }
}

extension CommonGroundNearbyLocator: CLLocationManagerDelegate {
    nonisolated func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
        MainActor.assumeIsolated { accessChanged() }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
        MainActor.assumeIsolated { received(locations) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
        MainActor.assumeIsolated { failed(error) }
    }

    nonisolated func locationManager(_ manager: CLLocationManager, didExitRegion region: CLRegion) {
        MainActor.assumeIsolated { exited(region) }
    }
}
