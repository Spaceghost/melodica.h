export function publicRoomMember(member) {
  if (!member || typeof member !== 'object' || Array.isArray(member)) return {};
  const out = {};
  for (const key of ['account', 'name', 'github', 'role']) {
    if (typeof member[key] === 'string') out[key] = member[key].slice(0, 256);
  }
  if (typeof member.joined_at === 'string') out.joined_at = member.joined_at.slice(0, 256);
  else if (Number.isFinite(member.joined_at)) out.joined_at = member.joined_at;
  return out;
}
