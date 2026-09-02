/**
 * Replace the service-title half of a Cal snapshot
 * ("Title between Organiser and Guest") with the live catalogue title.
 * Keeps the attendee suffix when present.
 */

function primaryServiceTitle(stored) {
  if (stored == null) return '';
  const raw = String(stored).trim();
  if (!raw) return '';
  const betweenIdx = raw.toLowerCase().indexOf(' between ');
  if (betweenIdx === -1) return raw;
  return raw.slice(0, betweenIdx).trim();
}

function applyCatalogueTitleToServiceName(stored, catalogueTitle) {
  const title = catalogueTitle == null ? '' : String(catalogueTitle).trim();
  if (!title) {
    return stored == null ? null : String(stored);
  }
  const raw = stored == null ? '' : String(stored);
  const betweenIdx = raw.toLowerCase().indexOf(' between ');
  if (betweenIdx === -1) return title;
  return `${title}${raw.slice(betweenIdx)}`;
}

module.exports = {
  primaryServiceTitle,
  applyCatalogueTitleToServiceName,
};
