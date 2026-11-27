/**
 * Self-check for monthly route plans (assignmentModel), against an in-memory
 * table instead of Supabase, so it never touches real data. From Keil/backend:
 *   npx tsx src/modules/keil/models/assignmentModel.check.ts
 */
import assert from 'assert';
import path from 'path';

// ---- a tiny stand-in for the Supabase query builder, over in-memory rows ----
const db: Record<string, any[]> = { keil_route_assignments: [], keil_routes: [], keil_hces: [], keil_collection_headers: [] };
let nextId = 1;
class Query {
    private filters: ((r: any) => boolean)[] = [];
    private sorts: [string, boolean][] = [];
    private max: number | null = null;
    private op: 'select' | 'insert' | 'update' | 'delete' = 'select';
    private payload: any = null;
    private one: '' | 'single' | 'maybe' = '';
    constructor(private table: string) {}
    select() { return this; }
    eq(c: string, v: any) { this.filters.push(r => r[c] === v); return this; }
    in(c: string, vs: any[]) { this.filters.push(r => vs.includes(r[c])); return this; }
    gt(c: string, v: any) { this.filters.push(r => r[c] != null && r[c] > v); return this; }
    lt(c: string, v: any) { this.filters.push(r => r[c] != null && r[c] < v); return this; }
    gte(c: string, v: any) { this.filters.push(r => r[c] != null && r[c] >= v); return this; }
    lte(c: string, v: any) { this.filters.push(r => r[c] != null && r[c] <= v); return this; }
    order(c: string, o: { ascending?: boolean } = {}) { this.sorts.push([c, o.ascending !== false]); return this; }
    limit(n: number) { this.max = n; return this; }
    insert(rows: any[]) { this.op = 'insert'; this.payload = rows; return this; }
    update(p: any) { this.op = 'update'; this.payload = p; return this; }
    delete() { this.op = 'delete'; return this; }
    single() { this.one = 'single'; return this; }
    maybeSingle() { this.one = 'maybe'; return this; }
    then(ok: any, fail: any) { return Promise.resolve().then(() => this.run()).then(ok, fail); }
    private run() {
        const rows = db[this.table];
        if (this.op === 'insert') {
            const made = this.payload.map((r: any) => ({ id: `id${nextId++}`, created_at: String(nextId).padStart(6, '0'), ...r }));
            rows.push(...made);
            return this.out(made);
        }
        let hit = rows.filter(r => this.filters.every(f => f(r)));
        if (this.op === 'update') { hit.forEach(r => Object.assign(r, this.payload)); return this.out(hit); }
        if (this.op === 'delete') { db[this.table] = rows.filter(r => !hit.includes(r)); return { data: null, error: null }; }
        for (const [c, asc] of [...this.sorts].reverse()) hit = [...hit].sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (asc ? 1 : -1));
        if (this.max != null) hit = hit.slice(0, this.max);
        return this.out(hit.map(r => ({ ...r })));
    }
    private out(rows: any[]) {
        if (this.one === 'single') return rows.length === 1 ? { data: rows[0], error: null } : { data: null, error: { message: 'not one row' } };
        if (this.one === 'maybe') return { data: rows[0] ?? null, error: null };
        return { data: rows, error: null };
    }
}
const supabase = { from: (t: string) => new Query(t), rpc: async () => ({ data: 0, error: null }) };

process.env.JWT_SECRET = process.env.JWT_SECRET || 'check-only';
const configPath = require.resolve(path.join(__dirname, '../../../config/supabase'));
require.cache[configPath] = { id: configPath, filename: configPath, loaded: true, exports: { supabase } } as any;
const { AssignmentModel, currentMonth } = require('./assignmentModel');

// ---- data: two routes, this month's plan and last month's ----
const CO = 'co1';
const NOW = currentMonth();
const [y, m] = NOW.split('-').map(Number);
const PAST = `${m === 1 ? y - 1 : y}-${String(m === 1 ? 12 : m - 1).padStart(2, '0')}-01`;
const NEXT = `${m === 12 ? y + 1 : y}-${String(m === 12 ? 1 : m + 1).padStart(2, '0')}-01`;
const MT = ['Monday', 'Thursday'];
db.keil_routes.push({ id: 'ekm1', company_id: CO, branch_id: 'b1' }, { id: 'ekm2', company_id: CO, branch_id: 'b1' });
const link = (route_id: string, hce_id: string, sl_no: number | null, sequence_order: number, plan_month = NOW, days = MT) =>
    db.keil_route_assignments.push({ id: `${route_id}-${hce_id}-${plan_month}`, route_id, hce_id, sl_no, sequence_order, plan_month, company_id: CO, collection_days: days });
// EKM 1, Mon & Thu, from a sheet: Thrippunithura 1, Vyttila 2, Palarivattom 3
link('ekm1', 'thrippunithura', 1, 1); link('ekm1', 'vyttila', 2, 2); link('ekm1', 'palarivattom', 3, 3);
link('ekm1', 'old-only', 1, 1, PAST);
link('ekm2', 'kakkanad', null, 1); link('ekm2', 'edappally', null, 2);

const staff = { role_name: 'SUPERVISOR' };
const manager = { role_name: 'MANAGER OPERATIONS' };
const list = (route: string, month = NOW) => db.keil_route_assignments
    .filter(l => l.route_id === route && l.plan_month === month)
    .sort((a, b) => (a.sl_no ?? a.sequence_order) - (b.sl_no ?? b.sequence_order) || a.sequence_order - b.sequence_order)
    .map(l => `${l.sl_no ?? '-'}:${l.hce_id}`);

(async () => {
    // A month shows its own plan; a month not started shows the latest before it
    const now = await AssignmentModel.getRouteAssignments('ekm1', NOW.slice(0, 7));
    assert.strictEqual(now.plan_month, NOW);
    assert.strictEqual(now.data.length, 3, 'this month: its own 3 links, not last month’s');
    assert.strictEqual((await AssignmentModel.getRouteAssignments('ekm1', PAST.slice(0, 7))).data.length, 1, 'past month keeps its own list');
    assert.strictEqual((await AssignmentModel.getRouteAssignments('ekm1', NEXT.slice(0, 7))).plan_month, NOW, 'next month (not started) shows this month’s plan');

    // New affiliation in Vyttila, inserted at SL NO 2: the ones from 2 on move one along
    await AssignmentModel.assignHce({ route_id: 'ekm1', hce_id: 'vyttila-new', collection_days: MT, collection_type: 'Twice', plan_month: NOW.slice(0, 7), position: 2 }, staff);
    assert.deepStrictEqual(list('ekm1'), ['1:thrippunithura', '2:vyttila-new', '3:vyttila', '4:palarivattom']);
    // Without a position it goes last, numbered after the last SL NO
    await AssignmentModel.assignHce({ route_id: 'ekm1', hce_id: 'kaloor', collection_days: MT, plan_month: NOW.slice(0, 7) }, staff);
    assert.deepStrictEqual(list('ekm1').slice(-1)[0], '5:kaloor');
    // A list without SL NOs (added by hand) is ordered by position instead
    await AssignmentModel.assignHce({ route_id: 'ekm2', hce_id: 'vazhakkala', collection_days: MT, plan_month: NOW.slice(0, 7), position: 2 }, staff);
    assert.deepStrictEqual(list('ekm2'), ['-:kakkanad', '-:vazhakkala', '-:edappally']);

    // Move two to EKM 2: they leave EKM 1 (its numbers close the gap) and keep their order and days
    const ids = db.keil_route_assignments.filter(l => l.plan_month === NOW && ['vyttila-new', 'vyttila'].includes(l.hce_id)).map(l => l.id);
    await AssignmentModel.moveLinks({ ids, route_id: 'ekm2', position: 1 }, staff);
    assert.deepStrictEqual(list('ekm1'), ['1:thrippunithura', '2:palarivattom', '3:kaloor'], 'old route numbers close the gap');
    assert.deepStrictEqual(list('ekm2'), ['-:vyttila-new', '-:vyttila', '-:kakkanad', '-:vazhakkala', '-:edappally'], 'arrive in order at the top');
    assert.ok(db.keil_route_assignments.filter(l => ids.includes(l.id)).every(l => l.collection_days === MT && l.plan_month === NOW), 'days and month kept');
    assert.deepStrictEqual(list('ekm1', PAST), ['1:old-only'], 'last month untouched by this month’s changes');

    // Past months: staff cannot change them; Manager Operations can
    const pastLink = db.keil_route_assignments.find(l => l.plan_month === PAST)!;
    await assert.rejects(AssignmentModel.removeHce(pastLink.id, staff), (e: any) => e.status === 403);
    await assert.rejects(AssignmentModel.assignHce({ route_id: 'ekm1', hce_id: 'x', collection_days: MT, plan_month: PAST.slice(0, 7) }, staff), (e: any) => e.status === 403);
    await AssignmentModel.assignHce({ route_id: 'ekm1', hce_id: 'late-add', collection_days: MT, plan_month: PAST.slice(0, 7) }, manager);
    assert.deepStrictEqual(list('ekm1', PAST), ['1:old-only', '2:late-add']);

    // A month not started yet cannot be edited (it would start with one link and hide every other route)
    await assert.rejects(AssignmentModel.assignHce({ route_id: 'ekm1', hce_id: 'x', collection_days: MT, plan_month: NEXT.slice(0, 7) }, manager), (e: any) => e.status === 409);
    // Only Admin and Manager Operations start a month
    await assert.rejects(AssignmentModel.startMonth({ company_id: CO, plan_month: NEXT.slice(0, 7) }, staff), (e: any) => e.status === 403);
    await assert.doesNotReject(AssignmentModel.startMonth({ company_id: CO, plan_month: NEXT.slice(0, 7) }, { role_name: 'admin' }));

    // Bulk upload keeps the same month rules: staff cannot upload into a past month, Manager Operations can;
    // nobody can upload into a month that is not started
    const sheet = (plan_month: string) => ({ route_id: 'ekm2', collection_days: ['Tuesday', 'Friday'], collection_type: 'Twice', plan_month,
        items: [{ hce_id: 'aluva', sl_no: 1 }, { hce_id: 'angamaly', sl_no: 2 }] });
    await assert.rejects(AssignmentModel.replaceDayList(sheet(PAST.slice(0, 7)), staff), (e: any) => e.status === 403);
    await AssignmentModel.replaceDayList(sheet(PAST.slice(0, 7)), manager);
    assert.deepStrictEqual(db.keil_route_assignments.filter(l => l.route_id === 'ekm2' && l.plan_month === PAST).map(l => l.hce_id), ['aluva', 'angamaly'], 'manager uploaded into the past month');
    await assert.rejects(AssignmentModel.replaceDayList(sheet('2099-01'), manager), (e: any) => e.status === 409);
    await AssignmentModel.replaceDayList(sheet(NOW.slice(0, 7)), staff);
    assert.ok(db.keil_route_assignments.some(l => l.hce_id === 'aluva' && l.plan_month === NOW), 'staff uploads into this month');

    // The bin icon closes the SL NO gap: EKM 1 is 1 thrippunithura, 2 palarivattom, 3 kaloor
    await AssignmentModel.removeHce(db.keil_route_assignments.find(l => l.plan_month === NOW && l.hce_id === 'thrippunithura')!.id, staff);
    assert.deepStrictEqual(list('ekm1'), ['1:palarivattom', '2:kaloor']);

    // Undo a month started by mistake: only the newest plan, not the first, not once collections are saved there
    await assert.rejects(AssignmentModel.undoStartMonth({ company_id: CO, plan_month: NEXT.slice(0, 7) }, staff), (e: any) => e.status === 403);
    await assert.rejects(AssignmentModel.undoStartMonth({ company_id: CO, plan_month: PAST.slice(0, 7) }, manager), (e: any) => e.status === 409); // first plan
    db.keil_route_assignments.push({ id: 'next-1', route_id: 'ekm1', hce_id: 'copied', plan_month: NEXT, company_id: CO, collection_days: MT, sequence_order: 1, sl_no: 1 });
    await assert.rejects(AssignmentModel.undoStartMonth({ company_id: CO, plan_month: NOW.slice(0, 7) }, manager), (e: any) => e.status === 409); // a later one exists
    db.keil_collection_headers.push({ id: 'c1', company_id: CO, collection_date: NEXT.slice(0, 8) + '05' });
    await assert.rejects(AssignmentModel.undoStartMonth({ company_id: CO, plan_month: NEXT.slice(0, 7) }, manager), (e: any) => e.status === 409); // collections saved
    db.keil_collection_headers.length = 0;
    await AssignmentModel.undoStartMonth({ company_id: CO, plan_month: NEXT.slice(0, 7) }, manager);
    assert.ok(!db.keil_route_assignments.some(l => l.plan_month === NEXT), 'next month plan removed');
    assert.deepStrictEqual(list('ekm1'), ['1:palarivattom', '2:kaloor'], 'this month untouched by the undo');
    assert.strictEqual((await AssignmentModel.getRouteAssignments('ekm1', NEXT.slice(0, 7))).plan_month, NOW, 'next month shows this month again');

    console.log('assignment-model: all checks passed');
})().catch(e => { console.error(e); process.exit(1); });
