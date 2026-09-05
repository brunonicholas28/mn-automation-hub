// Lane 2 promotion score, per claude/linkedin-lane2-scoring-spec.md.
// score = reply_bonus + open_score + trigger_score + deal_value_score

export function computeScore({
  replied,
  opened,
  hasSpecificTrigger,
  reportCompleted,
  reportIsTier3Shaped,
  revenueBandUpperFit,
}) {
  const reply_bonus = replied ? 1000 : 0;
  const open_score = !replied && opened ? 20 : 0;
  const trigger_score = hasSpecificTrigger ? 15 : 0;

  let deal_value_score = 0;
  if (reportCompleted && reportIsTier3Shaped) deal_value_score = 10;
  else if (!reportCompleted && revenueBandUpperFit) deal_value_score = 5;

  return reply_bonus + open_score + trigger_score + deal_value_score;
}

// Weekly cutoff logic: sort descending by score, tie-break by earliest
// engagement timestamp, reserve a fast-track buffer for network-proximity
// contacts, then fill the remaining slots top-down.
export function buildWeeklyShortlist(
  contacts,
  { weeklyCap = 80, fastTrackBuffer = 15 } = {}
) {
  const fastTrack = contacts.filter((c) => c.networkProximity);
  const scored = contacts
    .filter((c) => !c.networkProximity && c.score > 0)
    .sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const aTime = a.earliestEngagementAt ? new Date(a.earliestEngagementAt).getTime() : Infinity;
      const bTime = b.earliestEngagementAt ? new Date(b.earliestEngagementAt).getTime() : Infinity;
      return aTime - bTime;
    });

  const fastTrackSlots = Math.min(fastTrack.length, fastTrackBuffer);
  const remainingSlots = Math.max(weeklyCap - fastTrackSlots, 0);

  return {
    fastTrack: fastTrack.slice(0, fastTrackSlots),
    ranked: scored.slice(0, remainingSlots),
    overflowFastTrack: fastTrack.slice(fastTrackSlots), // didn't fit even in the buffer
  };
}
