/**
 * What is painting this element, composed down the ancestor chain.
 *
 * `getComputedStyle(el)` answers one link of a chain. CSS rasterisation composes: an ancestor's
 * `filter`, `opacity`, `transform`, `mix-blend-mode` or `backdrop-filter` changes how this element
 * reaches the screen while leaving its own computed style byte-identical.
 *
 * That is not a hypothetical. It is the regression Reticle measurably lost to a screenshot: a
 * `hue-rotate(90deg)` on an ancestor changed 21,393 pixels, and the element's own style was the same
 * before and after — correctly, because the filter was never its property. The read was not wrong;
 * it was at the wrong layer.
 *
 * Verified in a real browser before this was written. Same element, before and after:
 *
 *   own computed style   padding 16px, background rgb(255,255,255), filter "none"   IDENTICAL
 *   paint context        []  ->  [{ on: "wrap", property: "filter", value: "hue-rotate(90deg)" }]
 *
 * A screenshot is the lazy way to collapse this composition — it collapses it into pixels and throws
 * away every term, which is why it can report that 21,393 pixels differ and never say which element,
 * which property, or which line of code. This keeps the terms, so a finding is attributable.
 */

import { isHtmlElement } from './realm.js';

/** One reason this element does not rasterise the way its own style suggests. */
export interface PaintContextEntry {
  /** A description of the element applying it — its id, else its classes, else its tag. */
  readonly on: string;
  readonly property: string;
  readonly value: string;
}

/**
 * The properties that alter rasterisation WITHOUT altering the subject's own computed style.
 *
 * Deliberately short. Every entry is a property whose effect is inherited by the rendering of
 * descendants rather than by their computed values, which is precisely the blind spot. Colour,
 * font and spacing are NOT here: those show up in the element's own style, where they are already
 * read.
 */
const PAINT_PROPERTIES = [
  'filter',
  'opacity',
  'transform',
  'mix-blend-mode',
  'backdrop-filter',
] as const;

/** The value each property has when it is doing nothing. A default is not a paint context. */
const INERT: Readonly<Record<string, string>> = {
  filter: 'none',
  opacity: '1',
  transform: 'none',
  'mix-blend-mode': 'normal',
  'backdrop-filter': 'none',
};

/** Enough to find the element again, in the words a reader already has. */
function describeElement(el: Element): string {
  if (el.id.length > 0) return `#${el.id}`;
  const cls = el.getAttribute('class');
  if (cls !== null && cls.trim().length > 0) return `.${cls.trim().split(/\s+/).join('.')}`;
  return el.tagName.toLowerCase();
}

/**
 * Nearest first, so the closest cause reads first — that is the one somebody edits.
 *
 * Walks the element itself and then its ancestors: the question is "what is painting this", not
 * "what is above this", and an element can tint itself.
 */
export function paintContextOf(el: Element): PaintContextEntry[] {
  const view = el.ownerDocument.defaultView;
  if (null === view) return [];
  const found: PaintContextEntry[] = [];
  for (
    let node: Element | null = el;
    node !== null && node !== el.ownerDocument.documentElement;
    node = node.parentElement
  ) {
    const style = view.getComputedStyle(node);
    for (const property of PAINT_PROPERTIES) {
      const value = style.getPropertyValue(property);
      if (value.length > 0 && value !== INERT[property]) {
        found.push({ on: describeElement(node), property, value });
      }
    }
  }
  return found;
}

/**
 * The clip an ancestor's overflow puts on what reaches the screen: the other half of the ancestor
 * chain that `a11y.ts` walks to decide whether an element is visible and in the viewport.
 */
export type VisibleBounds = Pick<DOMRect, 'left' | 'right' | 'top' | 'bottom' | 'width' | 'height'>;
export interface VisibilityInfo {
  hidden: boolean;
  style: CSSStyleDeclaration | null;
  parent: Element | null;
  clipX: boolean;
  clipY: boolean;
  /** Scrollable on that axis: content past the edge is reachable by scrolling. */
  scrollX: boolean;
  scrollY: boolean;
  hasClipping: boolean;
  clipBox?: VisibleBounds;
}

export function overflowAxes(style: CSSStyleDeclaration | null): [string, string] {
  const shorthand = style?.overflow ?? '';
  const [x = 'visible', y = x] = ('' === shorthand ? 'visible' : shorthand).split(/\s+/);
  return [
    null === style || '' === style.overflowX ? x : style.overflowX,
    null === style || '' === style.overflowY ? y : style.overflowY,
  ];
}

export function clippingBox(el: Element, info: VisibilityInfo): VisibleBounds {
  if (info.clipBox !== undefined) {
    return info.clipBox;
  }
  const rect = el.getBoundingClientRect();
  const style = info.style;
  const px = (value: string | undefined): number => Number.parseFloat(value ?? '') || 0;
  const border = (value: string | undefined, kind: string | undefined): number =>
    kind === undefined || '' === kind || 'none' === kind || 'hidden' === kind ? 0 : px(value);
  const scaleX = isHtmlElement(el) && el.offsetWidth > 0 ? rect.width / el.offsetWidth : 1;
  const scaleY = isHtmlElement(el) && el.offsetHeight > 0 ? rect.height / el.offsetHeight : 1;
  const left =
    isHtmlElement(el) && el.offsetWidth > 0
      ? rect.left + el.clientLeft * scaleX
      : rect.left + border(style?.borderLeftWidth, style?.borderLeftStyle);
  const top =
    isHtmlElement(el) && el.offsetHeight > 0
      ? rect.top + el.clientTop * scaleY
      : rect.top + border(style?.borderTopWidth, style?.borderTopStyle);
  const right =
    isHtmlElement(el) && el.offsetWidth > 0
      ? left + el.clientWidth * scaleX
      : rect.right - border(style?.borderRightWidth, style?.borderRightStyle);
  const bottom =
    isHtmlElement(el) && el.offsetHeight > 0
      ? top + el.clientHeight * scaleY
      : rect.bottom - border(style?.borderBottomWidth, style?.borderBottomStyle);
  const margin = (style?.overflowClipMargin ?? '').split(/\s+/);
  const outset = px(margin.at(-1));
  const borderBox = margin.includes('border-box');
  const contentBox = margin.includes('content-box');
  const [x, y] = overflowAxes(style);
  const clipLeft =
    'clip' === x
      ? (borderBox ? rect.left : left + (contentBox ? px(style?.paddingLeft) * scaleX : 0)) -
        outset * scaleX
      : left;
  const clipRight =
    'clip' === x
      ? (borderBox ? rect.right : right - (contentBox ? px(style?.paddingRight) * scaleX : 0)) +
        outset * scaleX
      : right;
  const clipTop =
    'clip' === y
      ? (borderBox ? rect.top : top + (contentBox ? px(style?.paddingTop) * scaleY : 0)) -
        outset * scaleY
      : top;
  const clipBottom =
    'clip' === y
      ? (borderBox ? rect.bottom : bottom - (contentBox ? px(style?.paddingBottom) * scaleY : 0)) +
        outset * scaleY
      : bottom;
  info.clipBox = {
    left: clipLeft,
    right: clipRight,
    top: clipTop,
    bottom: clipBottom,
    width: clipRight - clipLeft,
    height: clipBottom - clipTop,
  };
  return info.clipBox;
}

/** A box outside a scrollport, moved to its near edge on each scrolling axis, as scrolling would. */
export function scrolledInto(
  b: VisibleBounds,
  port: VisibleBounds,
  alongX: boolean,
  alongY: boolean,
): VisibleBounds {
  const axis = (
    lo: number,
    hi: number,
    size: number,
    from: number,
    to: number,
  ): [number, number] => {
    if (hi > from && lo < to) {
      return [lo, hi];
    }
    const span = Math.min(size, to - from);
    return lo >= to ? [to - span, to] : [from, from + span];
  };
  const [left, right] = alongX
    ? axis(b.left, b.right, b.width, port.left, port.right)
    : [b.left, b.right];
  const [top, bottom] = alongY
    ? axis(b.top, b.bottom, b.height, port.top, port.bottom)
    : [b.top, b.bottom];
  return { left, right, top, bottom, width: right - left, height: bottom - top };
}
