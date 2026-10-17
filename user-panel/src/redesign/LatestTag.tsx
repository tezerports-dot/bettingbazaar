// GOVERNANCE: Read CLAUDE.md before editing this file. (See sec.0 for the mandatory pre-edit checklist.)
/**
 * Which end of a result strip is the newest (owner, 2026-10-17: "left to
 * right ... tell users which is the latest"). Every strip of results in the
 * player app reads newest on the LEFT and older to the right; the newest item
 * carries this tag (or `LATEST_RING` where a tag will not fit), and the strip
 * opens scrolled to its left end. One look for the big road, the run strip,
 * the recent results and the Results roadmap.
 */
import React from 'react';

/** The ring on the newest bead, where the strip has no room for a tag. */
export const LATEST_RING: React.CSSProperties = {
  outline: '2px solid var(--gold)', outlineOffset: 2,
};

/** The direction line every strip shows above itself. */
export const NEWEST_LEFT = 'Newest on the left · slide right for older';

export const LatestTag: React.FC<{ style?: React.CSSProperties }> = ({ style }) => (
  <span style={{
    display: 'inline-block', padding: '1px 6px', borderRadius: 999, background: 'var(--gold)', color: 'var(--on-gold)',
    fontSize: 8, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', lineHeight: 1.6, ...style,
  }}>
    Latest
  </span>
);
