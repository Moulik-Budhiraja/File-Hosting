import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { renderToStaticMarkup } from "react-dom/server";

import { ConfirmDialog } from "./components/ConfirmDialog";
import { NavRail } from "./components/NavRail";
import { ProposedBlock } from "./components/ProposedBlock";
import { StateBanner } from "./components/StateBanner";

describe("NavRail", () => {
  const markup = renderToStaticMarkup(
    <NavRail
      activeRoute="/admin/files"
      health={{ label: "GET /healthz 200", ok: true }}
      version="0.1.0"
      mobileOpen={false}
      onToggleMobile={() => undefined}
    />,
  );

  it("links the four admin routes with an accessible current marker", () => {
    assert.match(markup, /href="\/admin"/);
    assert.match(markup, /href="\/admin\/files"/);
    assert.match(markup, /href="\/admin\/inspector"/);
    assert.match(markup, /href="\/admin\/system"/);
    assert.match(markup, /aria-current="page"[^>]*>Files/);
    assert.doesNotMatch(markup, /aria-current="page"[^>]*>Overview/);
  });

  it("uses semantic nav markup and shows live health", () => {
    assert.match(markup, /<nav[^>]*aria-label="Admin"/);
    assert.match(markup, /GET \/healthz 200/);
    assert.match(markup, /fs-server/);
  });
});

describe("StateBanner", () => {
  it("renders each API state with distinct, truthful copy", () => {
    assert.match(
      renderToStaticMarkup(<StateBanner state="loading" />),
      /loading/i,
    );
    assert.match(renderToStaticMarkup(<StateBanner state="empty" />), /no /i);
    assert.match(
      renderToStaticMarkup(
        <StateBanner state="api" message="Cursor is invalid" />,
      ),
      /Cursor is invalid/,
    );
    assert.match(
      renderToStaticMarkup(<StateBanner state="disconnected" />),
      /unreachable|could not reach/i,
    );
    const loading = renderToStaticMarkup(<StateBanner state="loading" />);
    assert.match(loading, /role="status"/);
  });
});

describe("ProposedBlock", () => {
  it("carries the exact subordination label", () => {
    const markup = renderToStaticMarkup(
      <ProposedBlock items={["multi-user & RBAC"]} />,
    );
    assert.match(markup, /Proposed · Not implemented/);
    assert.match(markup, /multi-user &amp; RBAC/);
  });
});

describe("ConfirmDialog", () => {
  it("is an accessible modal with explicit confirm and cancel", () => {
    const markup = renderToStaticMarkup(
      <ConfirmDialog
        open
        title="Delete object"
        body="delete removes the object and its metadata row permanently · no soft-delete"
        confirmLabel="Delete"
        onCancel={() => undefined}
        onConfirm={() => undefined}
      />,
    );
    assert.match(markup, /role="alertdialog"/);
    assert.match(markup, /aria-modal="true"/);
    assert.match(markup, /aria-labelledby/);
    assert.match(markup, /Delete object/);
    assert.match(markup, /no soft-delete/);
    assert.match(markup, /<button[^>]*>Cancel<\/button>/);
    assert.match(markup, /<button[^>]*>Delete<\/button>/);
  });

  it("renders nothing while closed", () => {
    assert.equal(
      renderToStaticMarkup(
        <ConfirmDialog
          open={false}
          title="Delete object"
          body="body"
          confirmLabel="Delete"
          onCancel={() => undefined}
          onConfirm={() => undefined}
        />,
      ),
      "",
    );
  });
});
