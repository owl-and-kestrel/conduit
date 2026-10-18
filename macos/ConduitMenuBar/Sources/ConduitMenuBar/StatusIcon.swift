import AppKit
import ConduitMenuBarCore

/// Status-item glyphs for the five states (spec §3.1): template glyph (idle),
/// glyph with an activity dot (running), accent glyph plus count (needs you),
/// slashed glyph (paused) and a warning glyph (error).
enum ConduitIcon {
    static func apply(_ kind: StatusKind, to button: NSStatusBarButton) {
        switch kind {
        case .idle:
            button.image = makeStatusImage()
            button.title = ""
            button.toolTip = "Conduit · quiet"
        case .running:
            button.image = makeStatusImage(activityDot: true)
            button.title = ""
            button.toolTip = "Conduit · running"
        case .needsYou(let count):
            button.image = makeStatusImage(tint: .controlAccentColor)
            button.title = " \(count)"
            button.toolTip = count == 1 ? "Conduit · 1 request needs you" : "Conduit · \(count) requests need you"
        case .paused(let pending):
            button.image = makeStatusImage(slashed: true)
            button.title = pending > 0 ? " \(pending)" : ""
            button.toolTip = "Conduit · paused"
        case .error(let reason, _):
            button.image = makeWarningImage()
            button.title = ""
            button.toolTip = "Conduit · \(reason)"
        }
        button.imagePosition = button.title.isEmpty ? .imageOnly : .imageLeading
    }

    static func makeStatusImage(activityDot: Bool = false, slashed: Bool = false, tint: NSColor? = nil) -> NSImage {
        let image = NSImage(size: NSSize(width: 18, height: 18), flipped: false) { _ in
            let color = tint ?? NSColor.black
            color.setStroke()
            color.setFill()

            let outer = NSBezierPath(ovalIn: NSRect(x: 2, y: 2, width: 14, height: 14))
            outer.lineWidth = 1.7
            outer.stroke()

            let path = NSBezierPath()
            path.move(to: NSPoint(x: 9, y: 4))
            path.line(to: NSPoint(x: 13, y: 9))
            path.line(to: NSPoint(x: 9, y: 14))
            path.line(to: NSPoint(x: 5, y: 9))
            path.close()
            path.fill()

            if activityDot {
                NSBezierPath(ovalIn: NSRect(x: 12.5, y: 12.5, width: 5.5, height: 5.5)).fill()
            }
            if slashed {
                // Knock out a gap, then draw the slash, so it reads on any bar.
                NSGraphicsContext.current?.compositingOperation = .clear
                let gap = NSBezierPath()
                gap.move(to: NSPoint(x: 1.5, y: 16.5))
                gap.line(to: NSPoint(x: 16.5, y: 1.5))
                gap.lineWidth = 4
                gap.stroke()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
                let slash = NSBezierPath()
                slash.move(to: NSPoint(x: 1.5, y: 16.5))
                slash.line(to: NSPoint(x: 16.5, y: 1.5))
                slash.lineWidth = 1.7
                slash.stroke()
            }
            return true
        }
        image.isTemplate = tint == nil
        return image
    }

    static func makeWarningImage() -> NSImage {
        let image = NSImage(systemSymbolName: "exclamationmark.triangle", accessibilityDescription: "Conduit needs attention")
            ?? makeStatusImage()
        image.isTemplate = true
        return image
    }
}
