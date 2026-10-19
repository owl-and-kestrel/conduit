import AppKit
import ConduitMenuBarCore

/// Status-item glyphs (spec §3.1): all five states are one drawn 18×18 mark
/// (circle + diamond) plus one modifier — the always-template glyph for idle
/// and needs you, an activity dot for running, a slash for paused, and a
/// warning badge in the top-right corner for error.
enum ConduitIcon {
    static func apply(_ kind: StatusKind, to button: NSStatusBarButton) {
        switch kind {
        case .idle:
            button.image = glyph(for: kind)
            button.title = ""
            button.toolTip = "Conduit · quiet"
        case .running:
            button.image = glyph(for: kind)
            button.title = ""
            button.toolTip = "Conduit · running"
        case .needsYou(let count):
            button.image = makeStatusImage(tint: .controlAccentColor)
            button.title = " \(count)"
            button.toolTip = count == 1 ? "Conduit · 1 request needs you" : "Conduit · \(count) requests need you"
        case .paused(let pending):
            button.image = glyph(for: kind)
            button.title = pending > 0 ? " \(pending)" : ""
            button.toolTip = "Conduit · paused"
        case .error(let reason, _):
            button.image = glyph(for: kind)
            button.title = ""
            button.toolTip = "Conduit · \(reason)"
        }
        button.imagePosition = button.title.isEmpty ? .imageOnly : .imageLeading
    }

    /// The always-template (untinted) mark for a state. Running gets the
    /// activity dot, paused the slash, error the warning badge; idle and
    /// needs you keep the plain mark.
    static func glyph(for kind: StatusKind) -> NSImage {
        switch kind {
        case .idle, .needsYou:
            return makeStatusImage()
        case .running:
            return makeStatusImage(activityDot: true)
        case .paused:
            return makeStatusImage(slashed: true)
        case .error:
            return makeStatusImage(warningBadge: true)
        }
    }

    static func makeStatusImage(activityDot: Bool = false, slashed: Bool = false, warningBadge: Bool = false, tint: NSColor? = nil) -> NSImage {
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
            if warningBadge {
                // Knock out a circle in the top-right corner (like the slash
                // gap, so it reads on any bar), draw a small triangle there,
                // and knock a 1 pt "!" out of the triangle.
                NSGraphicsContext.current?.compositingOperation = .clear
                NSBezierPath(ovalIn: NSRect(x: 9.75, y: 9.75, width: 8, height: 8)).fill()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
                let triangle = NSBezierPath()
                triangle.move(to: NSPoint(x: 10.25, y: 10.75))
                triangle.line(to: NSPoint(x: 17.25, y: 10.75))
                triangle.line(to: NSPoint(x: 13.75, y: 17.25))
                triangle.close()
                triangle.fill()
                NSGraphicsContext.current?.compositingOperation = .clear
                NSBezierPath(rect: NSRect(x: 13.25, y: 13.4, width: 1, height: 2.3)).fill()
                NSBezierPath(ovalIn: NSRect(x: 13.25, y: 11.9, width: 1, height: 1)).fill()
                NSGraphicsContext.current?.compositingOperation = .sourceOver
            }
            return true
        }
        image.isTemplate = tint == nil
        return image
    }
}
