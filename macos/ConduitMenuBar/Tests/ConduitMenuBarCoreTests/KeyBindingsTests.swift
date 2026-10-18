import XCTest
@testable import ConduitMenuBarCore

/// S6: popover key bindings (spec §3.3) and ask selection.
final class KeyBindingsTests: XCTestCase {
    func testSpecBindings() {
        XCTAssertEqual(KeyBindings.command(for: KeyInput(.up)), .selectPrevious)
        XCTAssertEqual(KeyBindings.command(for: KeyInput(.down)), .selectNext)
        XCTAssertEqual(KeyBindings.command(for: KeyInput(.space)), .toggleDetails)
        XCTAssertEqual(KeyBindings.command(for: KeyInput(.returnKey)), .allowOnce)
        XCTAssertEqual(KeyBindings.command(for: KeyInput(.returnKey, command: true)), .allowWithScope)
        XCTAssertEqual(KeyBindings.command(for: KeyInput(.delete, command: true)), .deny)
        XCTAssertEqual(KeyBindings.command(for: KeyInput(.character("p"), command: true)), .togglePause)
        XCTAssertEqual(KeyBindings.command(for: KeyInput(.character(","), command: true)), .openSettings)
        XCTAssertEqual(KeyBindings.command(for: KeyInput(.escape)), .close)
    }

    func testNoAccidentalDecisions() {
        // Plain Delete is not Deny; ⇧Return, ⌃Return and ⌥Return are not Allow.
        XCTAssertNil(KeyBindings.command(for: KeyInput(.delete)))
        XCTAssertNil(KeyBindings.command(for: KeyInput(.returnKey, shift: true)))
        XCTAssertNil(KeyBindings.command(for: KeyInput(.returnKey, control: true)))
        XCTAssertNil(KeyBindings.command(for: KeyInput(.returnKey, option: true)))
        XCTAssertNil(KeyBindings.command(for: KeyInput(.character("p"))))
        XCTAssertNil(KeyBindings.command(for: KeyInput(.character("c"), option: true, control: true)), "the global hotkey is not a popover command")
    }

    func testHeldKeysNeverDecide() {
        // Holding Return or ⌘⌫ must not walk down the list deciding each ask.
        XCTAssertNil(KeyBindings.command(for: KeyInput(.returnKey, isRepeat: true)))
        XCTAssertNil(KeyBindings.command(for: KeyInput(.returnKey, command: true, isRepeat: true)))
        XCTAssertNil(KeyBindings.command(for: KeyInput(.delete, command: true, isRepeat: true)))
        // Holding an arrow still moves the selection.
        XCTAssertEqual(KeyBindings.command(for: KeyInput(.down, isRepeat: true)), .selectNext)
    }

    func testSelectionFollowsIdsAndFallsBackToOldest() {
        let a = Fixtures.approval(id: "approval_a", createdAt: "2026-10-18T06:00:00.000Z")
        let b = Fixtures.approval(id: "approval_b", createdAt: "2026-10-18T06:01:00.000Z")
        let c = Fixtures.approval(id: "approval_c", createdAt: "2026-10-18T06:02:00.000Z")
        var selection = AskSelection()
        selection.reconcile(with: [a, b, c])
        XCTAssertEqual(selection.selectedId, "approval_a")
        selection.move(1, in: [a, b, c])
        selection.move(1, in: [a, b, c])
        selection.move(1, in: [a, b, c])
        XCTAssertEqual(selection.selectedId, "approval_c", "clamped at the end")
        selection.reconcile(with: [a, b, c, Fixtures.approval(id: "approval_d")])
        XCTAssertEqual(selection.selectedId, "approval_c", "a refresh keeps the selection")
        selection.reconcile(with: [a, b])
        XCTAssertEqual(selection.selectedId, "approval_a", "a decided ask falls back to the oldest")
        selection.move(-1, in: [a, b])
        XCTAssertEqual(selection.selectedId, "approval_a")
        selection.reconcile(with: [])
        XCTAssertNil(selection.selectedId)
    }
}
