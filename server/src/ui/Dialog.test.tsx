import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, expect, test, vi } from "vitest";

import { Dialog } from "./Dialog";

afterEach(cleanup);

function Harness({ onClose = () => {} }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      {open ? (
        <Dialog
          title="New API key"
          onClose={() => {
            setOpen(false);
            onClose();
          }}
        >
          <input aria-label="Name" />
          <button type="button">Create key</button>
        </Dialog>
      ) : null}
    </div>
  );
}

test("dialog is modal, labelled by its title, and moves focus inside", async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Open dialog" }));
  const dialog = screen.getByRole("dialog", { name: "New API key" });
  expect(dialog.getAttribute("aria-modal")).toBe("true");
  expect(dialog.contains(document.activeElement)).toBe(true);
});

test("Escape closes the dialog and focus returns to the trigger", async () => {
  const onClose = vi.fn();
  render(<Harness onClose={onClose} />);
  const trigger = screen.getByRole("button", { name: "Open dialog" });
  await userEvent.click(trigger);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

test("Tab wraps focus inside the dialog", async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Open dialog" }));
  const name = screen.getByLabelText("Name");
  const create = screen.getByRole("button", { name: "Create key" });
  name.focus();
  await userEvent.tab({ shift: true });
  expect(document.activeElement).toBe(create);
  await userEvent.tab();
  expect(document.activeElement).toBe(name);
});

function BusyHarness({
  busy,
  onClose,
}: {
  busy: boolean;
  onClose: () => void;
}) {
  return (
    <div>
      <p>app background</p>
      <Dialog title="Delete file?" onClose={onClose} busy={busy}>
        <button type="button">Delete file</button>
      </Dialog>
    </div>
  );
}

test("Escape must not dismiss a dialog while its mutation is busy", async () => {
  const onClose = vi.fn();
  render(<BusyHarness busy onClose={onClose} />);
  await userEvent.keyboard("{Escape}");
  expect(onClose).not.toHaveBeenCalled();
  expect(screen.getByRole("dialog", { name: "Delete file?" })).toBeTruthy();
});

test("Escape still closes an idle dialog", async () => {
  const onClose = vi.fn();
  render(<BusyHarness busy={false} onClose={onClose} />);
  await userEvent.keyboard("{Escape}");
  expect(onClose).toHaveBeenCalledTimes(1);
});

test("the esc-closes hint is replaced while busy", () => {
  render(<BusyHarness busy onClose={vi.fn()} />);
  expect(screen.queryByText("esc closes")).toBeNull();
  expect(screen.getByText(/working/i)).toBeTruthy();
});

test("background content is inert and hidden from assistive tech while open", async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Open dialog" }));
  const dialog = screen.getByRole("dialog", { name: "New API key" });
  // Every body-level subtree that does not contain the dialog must be
  // inert + aria-hidden.
  const siblings = Array.from(document.body.children).filter(
    (element) => !element.contains(dialog),
  );
  expect(siblings.length).toBeGreaterThan(0);
  for (const sibling of siblings) {
    expect(sibling.hasAttribute("inert")).toBe(true);
    expect(sibling.getAttribute("aria-hidden")).toBe("true");
  }
});

test("closing the dialog restores background interactivity", async () => {
  render(<Harness />);
  await userEvent.click(screen.getByRole("button", { name: "Open dialog" }));
  await userEvent.keyboard("{Escape}");
  for (const element of Array.from(document.body.children)) {
    expect(element.hasAttribute("inert")).toBe(false);
    expect(element.getAttribute("aria-hidden")).not.toBe("true");
  }
});

test("nested dialogs restore inert state correctly on unwind", async () => {
  function Nested() {
    const [inner, setInner] = useState(false);
    return (
      <div>
        <p>deep background</p>
        <Dialog title="Outer" onClose={() => {}}>
          <button type="button" onClick={() => setInner(true)}>
            Open inner
          </button>
          {inner ? (
            <Dialog title="Inner" onClose={() => setInner(false)}>
              <button type="button">Inner action</button>
            </Dialog>
          ) : null}
        </Dialog>
      </div>
    );
  }
  render(<Nested />);
  await userEvent.click(screen.getByRole("button", { name: "Open inner" }));
  const inner = screen.getByRole("dialog", { name: "Inner" });
  expect(inner).toBeTruthy();
  // Close the inner dialog: the outer dialog must become interactive again.
  await userEvent.keyboard("{Escape}");
  const outer = screen.getByRole("dialog", { name: "Outer" });
  const outerRoot = Array.from(document.body.children).find((element) =>
    element.contains(outer),
  )!;
  expect(outerRoot.hasAttribute("inert")).toBe(false);
});
