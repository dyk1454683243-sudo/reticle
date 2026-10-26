/**
 * Text that a person cannot read must reach the verdict (#1797).
 *
 * A cart total had the right value and the same colour as the page background. A text check for it
 * passed, and the agent found the defect only in a screenshot. A text match whose colour is almost
 * the colour behind it, or whose composed opacity is almost zero, now carries `unreadable`.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { matchQuery } from './query.js';

afterEach(() => {
  document.body.innerHTML = '';
  document.body.removeAttribute('style');
});

const TOTAL = { text: 'Total: $50', matchCase: true };

describe('a text match that a person cannot read', () => {
  it('flags white text on a white page', () => {
    document.body.innerHTML = '<p style="color: rgb(255, 255, 255)">Total: $50</p>';
    expect(matchQuery(TOTAL).unreadable).toContain('contrast');
  });

  it('flags text in the colour of the nearest opaque ancestor background', () => {
    document.body.style.backgroundColor = 'rgb(255, 255, 255)';
    document.body.innerHTML =
      '<div style="background-color: rgb(17, 24, 39)"><span><p style="color: rgb(18, 25, 40)">Total: $50</p></span></div>';
    expect(matchQuery(TOTAL).unreadable).toContain('contrast');
  });

  it('flags text whose ancestors compose to almost no opacity', () => {
    document.body.innerHTML =
      '<div style="opacity: 0.1"><div style="opacity: 0.2"><p>Total: $50</p></div></div>';
    expect(matchQuery(TOTAL).unreadable).toContain('opacity');
  });

  it('does not flag dark text on a white page', () => {
    document.body.innerHTML = '<p style="color: rgb(0, 0, 0)">Total: $50</p>';
    expect(matchQuery(TOTAL).unreadable).toBeUndefined();
  });

  it('does not flag low-contrast text that a person can still read', () => {
    // About 2.3:1. It fails WCAG AA, and a person can still read it, so it is not this defect.
    document.body.innerHTML = '<p style="color: rgb(150, 150, 150)">Total: $50</p>';
    expect(matchQuery(TOTAL).unreadable).toBeUndefined();
  });

  it('composes a translucent background over the one behind it', () => {
    // Black at 10% over white is a light grey, so white text on it is near-invisible.
    document.body.innerHTML =
      '<div style="background-color: rgba(0, 0, 0, 0.1)"><p style="color: rgb(255, 255, 255)">Total: $50</p></div>';
    expect(matchQuery(TOTAL).unreadable).toContain('contrast');
  });

  it('does not judge text over a background image or gradient', () => {
    document.body.innerHTML =
      '<div style="background-image: linear-gradient(black, black)"><p style="color: rgb(255, 255, 255)">Total: $50</p></div>';
    expect(matchQuery(TOTAL).unreadable).toBeUndefined();
  });

  it('does not judge text with a shadow', () => {
    document.body.innerHTML =
      '<p style="color: rgb(255, 255, 255); text-shadow: 1px 1px 2px black">Total: $50</p>';
    expect(matchQuery(TOTAL).unreadable).toBeUndefined();
  });

  it('does not flag the match when one copy of the text is readable', () => {
    document.body.innerHTML =
      '<p style="color: rgb(255, 255, 255)">Total: $50</p><p style="color: rgb(0, 0, 0)">Total: $50</p>';
    expect(matchQuery(TOTAL).unreadable).toBeUndefined();
  });

  it('does not judge a query that does not match by text', () => {
    document.body.innerHTML = '<p data-testid="total" style="color: rgb(255, 255, 255)">x</p>';
    expect(matchQuery({ testid: 'total' }).unreadable).toBeUndefined();
  });
});
