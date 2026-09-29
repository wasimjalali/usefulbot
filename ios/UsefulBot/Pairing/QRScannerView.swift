import SwiftUI
import AVFoundation

/// The camera square's live preview (design spec 1.1): an
/// `AVCaptureSession` bound to `AVCaptureMetadataOutput` for QR codes only,
/// rendered through `AVCaptureVideoPreviewLayer` inside a
/// `UIViewControllerRepresentable`. No frames leave the device; detection is
/// the only output (`onScan`). On the simulator and on a denied camera the
/// view renders nothing — the sunken square and guides behind it show
/// through, which is the spec's Empty treatment.
struct QRScannerView: UIViewControllerRepresentable {
    /// Paused (loading) or offline: the capture session stops — the
    /// preview layer holds its last frame, which is the spec's freeze — and
    /// detection stops, so scanning can never fire while the status line
    /// says otherwise.
    var paused: Bool
    var onScan: (String) -> Void

    func makeUIViewController(context: Context) -> ScannerController {
        let controller = ScannerController()
        controller.onScan = onScan
        return controller
    }

    func updateUIViewController(_ controller: ScannerController, context: Context) {
        controller.onScan = onScan
        controller.scanningEnabled = !paused
    }
}

final class ScannerController: UIViewController, AVCaptureMetadataOutputObjectsDelegate {
    var onScan: (String) -> Void = { _ in }
    var scanningEnabled = true {
        didSet { updateScanning() }
    }

    /// Set once a code has been read: the coordinator decides whether it is
    /// a real pair (a second scan while Connecting must not double-fire).
    private var fired = false
    private let session = AVCaptureSession()
    private var previewLayer: AVCaptureVideoPreviewLayer?
    private let metadata = AVCaptureMetadataOutput()
    private let queue = DispatchQueue(label: "com.usefulbot.qr-scan")

    override func viewDidLoad() {
        super.viewDidLoad()
        view.backgroundColor = .clear
        configureSession()
    }

    override func viewDidLayoutSubviews() {
        super.viewDidLayoutSubviews()
        previewLayer?.frame = view.bounds
    }

    private func configureSession() {
        guard let device = AVCaptureDevice.default(for: .video),
              let input = try? AVCaptureDeviceInput(device: device),
              session.canAddInput(input), session.canAddOutput(metadata) else {
            // No camera (simulator): the sunken placeholder stays.
            return
        }
        session.addInput(input)
        session.addOutput(metadata)
        metadata.setMetadataObjectsDelegate(self, queue: queue)
        metadata.metadataObjectTypes = [.qr]
        let layer = AVCaptureVideoPreviewLayer(session: session)
        layer.videoGravity = .resizeAspectFill
        view.layer.addSublayer(layer)
        previewLayer = layer
        queue.async { [session] in
            session.startRunning()
        }
    }

    private func updateScanning() {
        queue.async { [weak self] in
            guard let self else { return }
            if self.scanningEnabled {
                // Resuming after an error clears the latch so the next code
                // can scan.
                self.fired = false
                if !self.session.isRunning { self.session.startRunning() }
            } else {
                self.fired = true
                // A stopped session holds the preview's last frame — the
                // design spec's "scanner freezes" — and no frames reach
                // detection while it is down.
                if self.session.isRunning { self.session.stopRunning() }
            }
        }
    }

    func metadataOutput(
        _ output: AVCaptureMetadataOutput,
        didOutput metadataObjects: [AVMetadataObject],
        from connection: AVCaptureConnection
    ) {
        guard scanningEnabled, !fired else { return }
        guard let object = metadataObjects.first(where: { $0.type == .qr }) as? AVMetadataMachineReadableCodeObject,
              let string = object.stringValue, !string.isEmpty else { return }
        fired = true
        let scan = string
        DispatchQueue.main.async { [onScan] in
            onScan(scan)
        }
    }

    /// Camera gone away / app backgrounded: release the session.
    func stop() {
        queue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }

    deinit {
        queue.async { [session] in
            if session.isRunning { session.stopRunning() }
        }
    }
}

/// Camera permission: `.authorized` scans, `.denied`/`.restricted` drive the
/// camera-denied state, `.notDetermined` requests. `UB_CAMERA_STATE` pins the
/// answer for the UI tests ("denied" simulates a refused camera).
enum CameraAccess {
    static func status() -> AVAuthorizationStatus {
        switch ProcessInfo.processInfo.environment["UB_CAMERA_STATE"] {
        case "denied": return .denied
        case "authorized": return .authorized
        default:
            break
        }
        return AVCaptureDevice.authorizationStatus(for: .video)
    }

    static func request() async -> AVAuthorizationStatus {
        if let forced = ProcessInfo.processInfo.environment["UB_CAMERA_STATE"] {
            return forced == "denied" ? .denied : .authorized
        }
        await AVCaptureDevice.requestAccess(for: .video)
        return AVCaptureDevice.authorizationStatus(for: .video)
    }
}
