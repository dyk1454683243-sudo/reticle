import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Presenter } from './presenter.js';
import { HudShell } from './presenter-shell.js';
import { CHAT_ATTR, CHAT_PANEL_ATTR, MIN_ATTR } from './presenter-config.js';
import { RAIL_ATTR, RAIL_SIGNIN_ATTR } from './presenter-frame.js';

/**
 * The HUD on a fresh page is the dock, and nothing more.
 *
 * A new user ran `init` and opened the app. The HUD opened the Agent Log by itself, and a separate
 * sign-in card sat above it. Together they covered the app's own links, and no agent had done
 * anything yet. The panel now opens when an agent acts in this tab, when the person presses the
 * dock, or when the person left it open before in this browser.
 */
const HUD_MOUNT_TIMEOUT_MS = 30_000;

const overlay = (): HTMLElement => {
  const el = document.querySelector<HTMLElement>('div[data-reticle-overlay]');
  if (null === el) {
    throw new Error('no overlay');
  }
  return el;
};
const chatOpen = (): boolean => '1' === overlay().getAttribute(CHAT_ATTR);
const press = (selector: string): void => {
  const el = document.querySelector<HTMLElement>(selector);
  if (null === el) {
    throw new Error(`no ${selector}`);
  }
  el.click();
};

/** A page load: a new presenter, mounted, and the bridge answers. */
const load = (): Presenter => {
  const presenter = new Presenter({});
  presenter.mount();
  presenter.sessionStart();
  return presenter;
};

/** Is this element drawn? jsdom does no layout, so walk the computed display and visibility. */
const drawn = (el: Element): boolean => {
  for (let node: Element | null = el; node !== null; node = node.parentElement) {
    const style = getComputedStyle(node);
    if ('none' === style.display || 'hidden' === style.visibility) {
      return false;
    }
    if (node instanceof HTMLElement && node.hidden) {
      return false;
    }
  }
  return true;
};

beforeEach(() => {
  localStorage.clear();
  sessionStorage.clear();
});
afterEach(() => {
  document.querySelectorAll('[data-reticle-overlay]').forEach((el) => el.remove());
  document.body.innerHTML = '';
});

describe('the HUD on first load', { timeout: HUD_MOUNT_TIMEOUT_MS }, () => {
  it('shows the dock only, with the panel closed', () => {
    const presenter = load();
    expect(overlay().getAttribute(MIN_ATTR)).toBe('1');
    expect(chatOpen(), 'the Agent Log opened with nothing to show').toBe(false);
    presenter.destroy();
  });

  it('takes no pointer event outside the dock while it is closed', () => {
    const presenter = load();
    const hud = overlay().querySelector('[data-reticle-hud]');
    // Every drawn HUD element outside the dock's own box lets a click through to the app under it.
    const catches = Array.from(overlay().querySelectorAll('*'))
      .filter((el) => hud?.contains(el) !== true && drawn(el))
      .filter((el) => 'none' !== getComputedStyle(el).pointerEvents)
      .map((el) => el.outerHTML.slice(0, 80));
    expect(catches).toEqual([]);
    expect(getComputedStyle(overlay()).pointerEvents).toBe('none');
    presenter.destroy();
  });

  it('opens the panel when the agent starts to act in this tab', () => {
    const presenter = load();
    presenter.narrate('Opening the settings page');
    expect(chatOpen()).toBe(true);
    presenter.destroy();
  });

  it('opens the panel when the person presses the dock', () => {
    const presenter = load();
    press('[data-reticle-fab]');
    expect(chatOpen()).toBe(true);
    presenter.destroy();
  });

  it('opens the panel on the next load when the person left it open', () => {
    const first = load();
    press('[data-reticle-fab]');
    first.destroy();
    const second = load();
    expect(chatOpen(), 'the person had the panel open, and the reload closed it').toBe(true);
    second.destroy();
  });

  it('keeps the panel closed on the next load when the person closed it', () => {
    const first = load();
    press('[data-reticle-fab]');
    press('[data-reticle-min-btn]');
    first.destroy();
    const second = load();
    expect(chatOpen()).toBe(false);
    second.destroy();
  });

  it('does not count an agent-opened panel as the person leaving it open', () => {
    const first = load();
    first.narrate('Checking the form');
    first.destroy();
    sessionStorage.clear(); // a new tab
    const second = load();
    expect(chatOpen()).toBe(false);
    second.destroy();
  });
});

describe('the sign-in ask', () => {
  it('sits inside the Agent Log, and no card floats over the app when signed out', () => {
    const shell = new HudShell({});
    const root = document.createElement('div');
    root.innerHTML = HudShell.dockHtml('', '', 'data-reticle-log', '', '');
    document.body.appendChild(root);
    shell.mount(root);
    shell.paintAccount({ signedIn: false }, undefined);
    const ask = root.querySelector(`[${RAIL_SIGNIN_ATTR}]`);
    expect(ask?.closest(`[${CHAT_PANEL_ATTR}]`)).not.toBeNull();
    expect(ask?.closest(`[${RAIL_ATTR}]`)).toBeNull();
    expect(root.querySelector<HTMLElement>(`[${RAIL_ATTR}]`)?.hidden).toBe(true);
    shell.teardown();
  });
});
