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
