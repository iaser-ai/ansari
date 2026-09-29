/**
 * The Hijri year, for dating the rail's colophon.
 *
 * Arithmetic rather than `Intl`: the tabular (Kuwaiti) calendar is pure
 * integer maths and gives the same answer on every platform, whereas
 * `Intl` with a non-Gregorian calendar depends on which ICU data the
 * runtime happens to ship — Hermes on device may carry none of it, and
 * a copyright line is not worth a platform branch.
 *
 * The tabular calendar can differ from an observed sighting by a day at
 * the turn of a month. A year label is only wrong for that one day, at
 * the turn of the year, which is well inside what dating a footer asks
 * for.
 */
export function hijriYear(date: Date): number {
  const year = date.getFullYear();
  const month = date.getMonth() + 1;
  const day = date.getDate();

  // Gregorian date to Julian Day Number.
  const shift = Math.floor((month - 14) / 12);
  const jd =
    Math.floor((1461 * (year + 4800 + shift)) / 4) +
    Math.floor((367 * (month - 2 - 12 * shift)) / 12) -
    Math.floor((3 * Math.floor((year + 4900 + shift) / 100)) / 4) +
    day -
    32075;

  // Julian Day Number to the tabular Islamic year. 1948440 is the epoch,
  // 10631 the days in the calendar's 30-year cycle.
  const elapsed = jd - 1948440 + 10632;
  const cycles = Math.floor((elapsed - 1) / 10631);
  let remainder = elapsed - 10631 * cycles + 354;
  const yearInCycle =
    Math.floor((10985 - remainder) / 5316) *
      Math.floor((50 * remainder) / 17719) +
    Math.floor(remainder / 5670) * Math.floor((43 * remainder) / 15238);
  remainder =
    remainder -
    Math.floor((30 - yearInCycle) / 15) *
      Math.floor((17719 * yearInCycle) / 50) -
    Math.floor(yearInCycle / 16) * Math.floor((15238 * yearInCycle) / 43) +
    29;

  return 30 * cycles + yearInCycle - 30;
}
