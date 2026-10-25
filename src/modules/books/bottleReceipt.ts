import type { CompanyConfig, Location, Unit } from '../../core/types';

/**
 * What every page says about where one bottle came from and what it cost: the scan page, the receipt (its code on the
 * black panel), the open books' bottle page and the app's bottle page all use these, so they never disagree.
 */

/** A bottle's place, as anyone may see it: a machine by its id and name, a delivery by its city only (never a street). */
export function publicPlace(loc: Location | undefined, locationId: string): string {
  if (!loc) return locationId.startsWith('route') ? 'Home delivery' : locationId;
  return loc.kind === 'route' ? `Home delivery in ${loc.city}` : `${loc.id}, ${loc.name}`;
}

/**
 * Where a bottle came from, for the person who has it (the app's bottle cards and bottle page): a delivery area by its
 * name only ("Travis Heights"; its id, like "route-3", is internal), a machine by the number on it and its name.
 */
export function householdPlace(loc: Location | undefined, locationId: string): string {
  if (!loc) return /^route/i.test(locationId) ? 'Home delivery' : locationId;
  return loc.kind === 'route' ? loc.name : `${loc.id}, ${loc.name}`;
}

/** How the bottle reached its person: printed for a home delivery (a route, or a pack), or at a machine. */
export function distributedBy(u: Pick<Unit, 'locationId' | 'packId'>, loc: Location | undefined): 'delivery' | 'machine' {
  if (u.packId || loc?.kind === 'route' || (!loc && u.locationId.startsWith('route'))) return 'delivery';
  return 'machine';
}

/** "Printed fresh for home delivery in Austin", "Printed fresh at ATX-014, Congress Ave". */
export function printedFresh(u: Pick<Unit, 'locationId' | 'packId'>, loc: Location | undefined): string {
  const place = publicPlace(loc, u.locationId);
  return distributedBy(u, loc) === 'delivery'
    ? `Printed fresh for ${/^home delivery/i.test(place) ? `${place.charAt(0).toLowerCase()}${place.slice(1)}` : `home delivery (${place})`}`
    : `Printed fresh at ${place}`;
}

/**
 * The bottle's standard costs, line by line, with only the costs of how it was handed out: a delivered bottle carries
 * its delivery (packing, the route and the van), a machine's bottle its machine and restocking, never the other's.
 * The company sets one standard cost for either ("machine or delivery", console: Standard costs).
 */
export function bottleCostLines(company: Pick<CompanyConfig, 'unitCosts'>, how: 'delivery' | 'machine'): { label: string; cents: number }[] | null {
  const uc = company.unitCosts;
  if (!uc) return null;
  return [
    { label: 'Spring water', cents: uc.water },
    { label: 'Bottle and cap', cents: uc.bottle },
    { label: 'Label and ink', cents: uc.label },
    how === 'delivery' ? { label: 'Home delivery (packing, route and van)', cents: uc.machine } : { label: 'Machine and restock', cents: uc.machine },
  ];
}
