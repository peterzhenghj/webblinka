import { el, svg } from "../dom.ts";

/**
 * Where the fixes are landing, drawn from the page's own data.
 *
 * Deliberately not a tile map. Tiles would mean asking a third party for
 * imagery of wherever the receiver happens to be, on every fix — which for a
 * page whose whole claim is that nothing leaves your machine is a poor trade
 * for a picture of streets you are presumably sitting on. There is a link out
 * for when you do want that, and following it is a decision rather than a side
 * effect of watching the panel.
 *
 * What this shows instead is the thing a street map cannot: the *scatter*. A
 * stationary receiver reports a slightly different position every second, and
 * the size and shape of that cloud is the receiver's precision — the number
 * that actually tells you how much to trust the coordinates.
 */

/** Viewport of the SVG, in its own units. */
const SIZE = 240;
/** Never zoom in past this, or a still receiver fills the plot with noise. */
const MIN_SPAN_M = 8;
const MAX_HISTORY = 600;
/**
 * Rough metres of error per unit of HDOP. The real figure depends on the
 * receiver and the sky; this is the conventional back-of-envelope one, which is
 * why the circle is drawn faintly and labelled as an estimate.
 */
const METRES_PER_HDOP = 5;

export interface Fix {
  latitude: number;
  longitude: number;
}

interface Point {
  east: number;
  north: number;
}

export class GpsMap {
  readonly root: HTMLElement;
  readonly #plot: HTMLElement;
  readonly #caption: HTMLElement;
  readonly #link: HTMLAnchorElement;
  readonly #history: Fix[] = [];

  constructor() {
    this.#plot = el("div", { class: "gps-plot" });
    this.#caption = el("p", { class: "hint" });
    this.#link = el("a", {
      class: "hint",
      target: "_blank",
      rel: "noreferrer noopener",
      text: "Open in OpenStreetMap",
    });
    this.root = el("div", { class: "gps-map", hidden: true }, [
      el("h3", { class: "subhead", text: "Position scatter" }),
      this.#plot,
      this.#caption,
      this.#link,
    ]);
  }

  /** Called on every poll. A fix without a position is not a fix worth plotting. */
  update(fix: {
    hasFix: boolean;
    latitude: number | null;
    longitude: number | null;
    hdop: number | null;
  }): void {
    if (!fix.hasFix || fix.latitude == null || fix.longitude == null) {
      this.root.hidden = true;
      return;
    }
    this.root.hidden = false;

    const last = this.#history.at(-1);
    if (!last || last.latitude !== fix.latitude || last.longitude !== fix.longitude) {
      this.#history.push({ latitude: fix.latitude, longitude: fix.longitude });
      if (this.#history.length > MAX_HISTORY) this.#history.shift();
    }

    this.#render(fix.hdop);
    this.#link.href =
      `https://www.openstreetmap.org/?mlat=${fix.latitude}&mlon=${fix.longitude}` +
      `#map=18/${fix.latitude}/${fix.longitude}`;
  }

  reset(): void {
    this.#history.length = 0;
    this.root.hidden = true;
  }

  #render(hdop: number | null): void {
    const centre = mean(this.#history);
    const points = this.#history.map((fix) => offsetMetres(centre, fix));
    const current = points.at(-1);
    if (!current) return;

    // Fit the scatter *and* the accuracy circle. Sizing to the scatter alone
    // lets a large HDOP paint the whole frame, which reads as "everything is
    // uncertain" when the point is to see how the estimate compares to the
    // spread actually observed.
    const furthest = Math.max(...points.map((p) => Math.hypot(p.east, p.north)), 0);
    const estimate = hdop != null && hdop > 0 ? hdop * METRES_PER_HDOP : 0;
    const span = niceSpan(Math.max(furthest * 2.4, estimate * 2.4, MIN_SPAN_M));
    const scale = SIZE / span;
    const x = (p: Point) => SIZE / 2 + p.east * scale;
    const y = (p: Point) => SIZE / 2 - p.north * scale; // SVG y grows downward

    const rings = [span / 4, span / 2].map((radius) =>
      svg("circle", {
        cx: SIZE / 2,
        cy: SIZE / 2,
        r: radius * scale,
        class: "gps-plot-ring",
      }),
    );

    // Centred on the mean, not on the latest fix: this is an estimate of the
    // solution's error, and drawing it around the centre of the scatter is what
    // makes "estimated" and "observed" directly comparable. Hanging it off the
    // most recent point would also let it drift out of frame.
    const accuracy =
      estimate > 0
        ? [
            svg("circle", {
              cx: SIZE / 2,
              cy: SIZE / 2,
              r: estimate * scale,
              class: "gps-plot-accuracy",
            }),
          ]
        : [];

    const track =
      points.length > 1
        ? [
            svg("polyline", {
              points: points.map((p) => `${x(p).toFixed(1)},${y(p).toFixed(1)}`).join(" "),
              class: "gps-plot-track",
            }),
          ]
        : [];

    this.#plot.replaceChildren(
      svg("svg", { viewBox: `0 0 ${SIZE} ${SIZE}`, class: "gps-plot-svg" }, [
        ...rings,
        svg("line", { x1: SIZE / 2, y1: 0, x2: SIZE / 2, y2: SIZE, class: "gps-plot-axis" }),
        svg("line", { x1: 0, y1: SIZE / 2, x2: SIZE, y2: SIZE / 2, class: "gps-plot-axis" }),
        ...accuracy,
        ...track,
        ...points.slice(0, -1).map((p) =>
          svg("circle", { cx: x(p), cy: y(p), r: 1.6, class: "gps-plot-past" }),
        ),
        svg("circle", { cx: x(current), cy: y(current), r: 4, class: "gps-plot-now" }),
      ]),
    );

    // Terse: this sits in a narrow column beside the readings, and a paragraph
    // here would be taller than the plot it describes. The reasoning lives in
    // the tooltip for anyone who wants it.
    const spread = rms(points);
    const lines = [
      `${span.toFixed(0)} m across · rings ${(span / 4).toFixed(1)}, ${(span / 2).toFixed(1)} m`,
      `${this.#history.length} ${this.#history.length === 1 ? "fix" : "fixes"} · ` +
        `${spread.toFixed(1)} m RMS`,
    ];
    if (estimate > 0) lines.push(`HDOP ${hdop?.toFixed(1)} ≈ ±${estimate.toFixed(0)} m (shaded)`);
    this.#caption.textContent = lines.join("\n");
    this.#caption.title =
      "Centred on the mean of the fixes so far, not on the latest one. The " +
      "shaded circle is the error HDOP implies; the dots are the error actually " +
      "observed. Comparing the two is the point.";
  }
}

function mean(fixes: Fix[]): Fix {
  const total = fixes.reduce(
    (acc, f) => ({ latitude: acc.latitude + f.latitude, longitude: acc.longitude + f.longitude }),
    { latitude: 0, longitude: 0 },
  );
  return { latitude: total.latitude / fixes.length, longitude: total.longitude / fixes.length };
}

/**
 * Degrees to metres. Over the tens of metres a stationary receiver wanders,
 * treating the Earth as locally flat is exact enough that the projection is not
 * the limiting error -- the receiver is.
 */
function offsetMetres(centre: Fix, fix: Fix): Point {
  const latitudeMetres = 110_574;
  const longitudeMetres = 111_320 * Math.cos((centre.latitude * Math.PI) / 180);
  return {
    east: (fix.longitude - centre.longitude) * longitudeMetres,
    north: (fix.latitude - centre.latitude) * latitudeMetres,
  };
}

function rms(points: Point[]): number {
  if (points.length === 0) return 0;
  const total = points.reduce((acc, p) => acc + p.east ** 2 + p.north ** 2, 0);
  return Math.sqrt(total / points.length);
}

/** Round the view up to a span whose quarter and half read as tidy numbers. */
function niceSpan(metres: number): number {
  const magnitude = 10 ** Math.floor(Math.log10(metres));
  for (const step of [1, 2, 4, 5, 10]) {
    if (metres <= step * magnitude) return step * magnitude;
  }
  return 10 * magnitude;
}
