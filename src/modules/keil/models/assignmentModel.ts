import { supabase } from '../../../config/supabase';
import { HCEModel } from './hceModel';
import { isRoutePlanner } from '../../../middleware/authMiddleware';

/** An HCE code as the registry compares it: digits without leading zeros ("00078" is 78). */
const codeKey = (v: unknown) => String(v ?? '').trim().replace(/\.0+$/, '').replace(/^0+(?=\d)/, '');

/** A facility name as compared across branches: its consonants and digits, so "Cherthala Thaluk" is "CHERTHALA TALUK". */
const nameKey = (v: unknown) => String(v ?? '').toLowerCase().replace(/[^a-z0-9]|[aeiouhy]/g, '');

const T = 'keil_route_assignments';

/** An error the controller answers with its own HTTP status (403, 409) instead of 500. */
const httpError = (status: number, message: string) => Object.assign(new Error(message), { status });

/** 'YYYY-MM' or a date 'YYYY-MM-DD' → that month's first day, 'YYYY-MM-01'. */
export const monthStart = (v: unknown) => {
    const m = String(v ?? '').match(/^(\d{4})-(\d{2})/);
    if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw httpError(400, 'A valid month (YYYY-MM) is required.');
    return `${m[1]}-${m[2]}-01`;
};

/** This month in India, 'YYYY-MM-01'. */
export const currentMonth = () => new Date(Date.now() + 5.5 * 3600e3).toISOString().slice(0, 7) + '-01';

const monthName = (m: string) => new Date(`${m}T00:00:00Z`).toLocaleString('en-IN', { month: 'long', year: 'numeric', timeZone: 'UTC' });

/** A list is a route's set of days ("Mon & Thu"), compared without regard to order. */
const daysKey = (days: string[] | null | undefined) => [...(days || [])].sort().join(',');

/**
 * The plan a month uses: that month's own plan once it is started, else the
 * latest started month before it (a month with no changes carries on the last
 * plan). Months before the first plan show the first plan.
 */
const planMonthFor = async (companyId: string, month: string) => {
    const { data: latest, error } = await supabase.from(T).select('plan_month')
        .eq('company_id', companyId).lte('plan_month', month)
        .order('plan_month', { ascending: false }).limit(1).maybeSingle();
    if (error) throw new Error(error.message);
    if (latest) return latest.plan_month as string;
    const { data: first, error: firstError } = await supabase.from(T).select('plan_month')
        .eq('company_id', companyId).order('plan_month', { ascending: true }).limit(1).maybeSingle();
    if (firstError) throw new Error(firstError.message);
    return (first?.plan_month as string) || month;
};

/**
 * A month's plan can be changed once it is started (or when no plan exists at
 * all yet), and a past month's only by Admin or Manager Operations.
 */
const assertWritable = async (user: any, companyId: string, month: string) => {
    if (month < currentMonth() && !isRoutePlanner(user)) {
        throw httpError(403, `Only Admin and Manager Operations can change the ${monthName(month)} route plan (a past month).`);
    }
    const exists = async (onlyThisMonth: boolean) => {
        let q = supabase.from(T).select('id').eq('company_id', companyId);
        if (onlyThisMonth) q = q.eq('plan_month', month);
        const { data, error } = await q.limit(1);
        if (error) throw new Error(error.message);
        return (data || []).length > 0;
    };
    if (!(await exists(true)) && (await exists(false))) {
        throw httpError(409, `The ${monthName(month)} route plan has not been started yet. Admin or Manager Operations can start it.`);
    }
};

/** The links of a set of ids, all from one month's plan (the month they are checked against). */
const linksOf = async (ids: string[]) => {
    const { data, error } = await supabase.from(T).select('*').in('id', ids);
    if (error) throw new Error(error.message);
    const months = [...new Set((data || []).map(l => l.plan_month))];
    if (months.length > 1) throw httpError(400, 'These facilities are in different months’ plans.');
    return data || [];
};

/**
 * Where a link goes in a route's list for its days, in one month's plan:
 * at SL NO `position` (the links from there on move one along, as when a row
 * is inserted in Excel), or at the end when no position is given. Makes room
 * and returns the link's sequence_order and sl_no.
 */
const placeInList = async (routeId: string, month: string, days: string[], position?: number | null) => {
    const { data: links, error } = await supabase.from(T)
        .select('id, collection_days, sequence_order, sl_no').eq('route_id', routeId).eq('plan_month', month);
    if (error) throw new Error(error.message);
    const all = links || [];
    const last = Math.max(0, ...all.map(l => l.sequence_order || 0));
    const list = all.filter(l => daysKey(l.collection_days) === daysKey(days));
    // A list from a sheet is numbered by its SL NOs; any other by its order
    const numbered = list.some(l => l.sl_no != null);
    const n = Math.round(Number(position));
    const update = async (rows: any[], change: (l: any) => any) => {
        const results = await Promise.all(rows.map(l => supabase.from(T).update(change(l)).eq('id', l.id)));
        const failed = results.find(r => r.error);
        if (failed?.error) throw new Error(failed.error.message);
    };

    if (!position || !Number.isFinite(n) || n < 1 || !list.length) {
        const nextSl = numbered ? Math.max(0, ...list.map(l => l.sl_no || 0)) + 1 : null;
        return { sequence_order: last + 1, sl_no: nextSl };
    }
    if (numbered) {
        if (list.some(l => l.sl_no === n)) await update(list.filter(l => l.sl_no != null && l.sl_no >= n), l => ({ sl_no: l.sl_no + 1 }));
        return { sequence_order: last + 1, sl_no: n };
    }
    const target = [...list].sort((a, b) => (a.sequence_order ?? 0) - (b.sequence_order ?? 0))[n - 1];
    if (!target) return { sequence_order: last + 1, sl_no: null };
    await update(all.filter(l => (l.sequence_order ?? 0) >= target.sequence_order), l => ({ sequence_order: (l.sequence_order ?? 0) + 1 }));
    return { sequence_order: target.sequence_order, sl_no: null };
};

/** A link leaves its list: the SL NOs after it close the gap. */
const closeGap = async (link: any) => {
    if (link.sl_no == null) return;
    const { data, error } = await supabase.from(T).select('id, collection_days, sl_no')
        .eq('route_id', link.route_id).eq('plan_month', link.plan_month).gt('sl_no', link.sl_no);
    if (error) throw new Error(error.message);
    const after = (data || []).filter(l => l.id !== link.id && daysKey(l.collection_days) === daysKey(link.collection_days));
    const results = await Promise.all(after.map(l => supabase.from(T).update({ sl_no: l.sl_no - 1 }).eq('id', l.id)));
    const failed = results.find(r => r.error);
    if (failed?.error) throw new Error(failed.error.message);
};

export const AssignmentModel = {
    /** A route's links in the plan that `month` uses, and which month's plan that is. */
    getRouteAssignments: async (routeId: string, month?: string) => {
        const { data: route, error: routeError } = await supabase.from('keil_routes').select('company_id').eq('id', routeId).single();
        if (routeError) throw new Error(routeError.message);
        const plan_month = await planMonthFor(route.company_id, month ? monthStart(month) : currentMonth());
        const { data, error } = await supabase
            .from(T)
            .select(`
                *,
                keil_hces (hce_name, hce_code, address, hce_place, collection_type)
            `)
            .eq('route_id', routeId)
            .eq('plan_month', plan_month)
            .order('sequence_order')
            .order('created_at');

        if (error) throw new Error(error.message);
        return { data: data || [], plan_month };
    },

    /** Start a month's plan: every route's latest plan copied into it, in one step. */
    startMonth: async ({ company_id, plan_month }: any, user: any) => {
        if (!isRoutePlanner(user)) throw httpError(403, 'Only Admin and Manager Operations can start a month’s route plan.');
        if (!company_id) throw httpError(400, 'company_id is required.');
        const { data, error } = await supabase.rpc('keil_start_route_month', { p_company: company_id, p_month: monthStart(plan_month) });
        if (error) throw httpError(409, error.message);
        return { copied: data as number, plan_month: monthStart(plan_month) };
    },

    /**
     * Link a facility to a route in a month's plan: at SL NO `position` of its
     * days' list, or last. A facility can be linked more than once (Mon & Thu
     * at one place in the order, Tue & Fri at another, or on another route):
     * each link keeps its own days and place.
     */
    assignHce: async (assignmentData: any, user: any) => {
        const { position, ...link } = assignmentData;
        const plan_month = monthStart(link.plan_month || currentMonth()); // an old page sends no month: this month
        const { data: route, error: routeError } = await supabase.from('keil_routes').select('company_id').eq('id', link.route_id).single();
        if (routeError) throw new Error(routeError.message);
        link.company_id = route.company_id;
        await assertWritable(user, link.company_id, plan_month);
        const place = await placeInList(link.route_id, plan_month, link.collection_days || [], position);

        const { data, error } = await supabase
            .from(T)
            .insert([{ ...link, plan_month, ...place }])
            .select()
            .single();

        if (error) throw new Error(error.message);
        return data;
    },

    /**
     * Move links to another route in the same month's plan, keeping their days:
     * from SL NO `position` on in the new route's list (or at its end). The old
     * route's SL NOs close the gap.
     */
    moveLinks: async ({ ids, route_id, position }: any, user: any) => {
        const links = await linksOf(ids);
        if (!links.length) throw httpError(404, 'Those facilities are no longer on the route.');
        const { data: target, error: targetError } = await supabase.from('keil_routes').select('id, company_id').eq('id', route_id).single();
        if (targetError) throw new Error(targetError.message);
        if (links.some(l => l.route_id === route_id)) throw httpError(400, 'Pick a different route to move them to.');
        const month = links[0].plan_month;
        await assertWritable(user, links[0].company_id, month);
        if (target.company_id !== links[0].company_id) throw httpError(400, 'That route belongs to another company.');

        // In the order shown on the old route, so they arrive in the same order
        const order = (l: any) => (l.sl_no ?? l.sequence_order ?? 0);
        const sorted = [...links].sort((a, b) => daysKey(a.collection_days).localeCompare(daysKey(b.collection_days)) || order(a) - order(b));
        const placed = new Map<string, number>(); // next position per days' list
        for (const stale of sorted) {
            const { data: link, error } = await supabase.from(T).select('*').eq('id', stale.id).single(); // SL NOs change as others leave
            if (error) throw new Error(error.message);
            await closeGap(link);
            const key = daysKey(link.collection_days);
            const at = position ? Number(position) + (placed.get(key) || 0) : null;
            placed.set(key, (placed.get(key) || 0) + 1);
            const place = await placeInList(route_id, month, link.collection_days || [], at);
            const { error: moveError } = await supabase.from(T).update({ route_id, ...place }).eq('id', link.id);
            if (moveError) throw new Error(moveError.message);
        }
        return { moved: sorted.length };
    },

    /**
     * Bulk upload of a route's list for one set of days, in one month's plan:
     * the facilities, in the order given, become the route's whole list for
     * those days. The route's other links lose those days, and go when none is
     * left; their other days stay. The new links go in before the old ones
     * change, so a failed upload loses nothing.
     *
     * An item is { hce_id } or, for a facility not found in the route's branch,
     * { hce_code, hce_name }. AFF NOs are numbered per branch, so it is the HCE
     * with that code in the route's branch; else the same hospital (same AFF NO
     * and name) registered under another branch; else it is registered in the
     * route's branch.
     */
    replaceDayList: async ({ route_id, company_id, collection_days, collection_type, items, plan_month: month }: any, user: any) => {
        const plan_month = monthStart(month || currentMonth());
        const { data: route, error: routeError } = await supabase
            .from('keil_routes').select('branch_id, company_id').eq('id', route_id).single();
        if (routeError) throw new Error(routeError.message);
        company_id = route.company_id;
        await assertWritable(user, company_id, plan_month);
        if (!route.branch_id) throw new Error('This route has no branch: set it in the Route Registry first.');

        const byCode = new Map<string, string>();    // AFF NO → HCE in the route's branch
        const elsewhere = new Map<string, string>(); // AFF NO and name → the same hospital under another branch
        const find = (i: any) => i.hce_id || byCode.get(codeKey(i.hce_code))
            || elsewhere.get(`${codeKey(i.hce_code)}|${nameKey(i.hce_name)}`);
        const unregistered = items.filter((i: any) => !i.hce_id);
        if (unregistered.length) {
            // Newest first, so of a hospital registered twice the oldest record wins
            (await HCEModel.getAll(company_id, [], true)).forEach(h => {
                if (h.branch_id === route.branch_id) byCode.set(codeKey(h.hce_code), h.id);
                else elsewhere.set(`${codeKey(h.hce_code)}|${nameKey(h.hce_name)}`, h.id);
            });
            const toCreate = new Map<string, any>();
            unregistered.forEach((i: any) => { if (!find(i)) toCreate.set(codeKey(i.hce_code), i); });
            if (toCreate.size) {
                const { data: created, error: createError } = await supabase
                    .from('keil_hces')
                    .insert([...toCreate.values()].map(i => ({
                        hce_code: String(i.hce_code).trim(),
                        hce_name: String(i.hce_name).trim().slice(0, 255),
                        branch_id: route.branch_id,
                        company_id,
                    })))
                    .select('id, hce_code');
                if (createError) throw new Error(createError.message);
                (created || []).forEach(h => byCode.set(codeKey(h.hce_code), h.id));
            }
        }
        const hce_ids = items.map(find);
        if (hce_ids.some((id: string | undefined) => !id)) throw new Error('Some facilities could not be registered in the HCE Registry.');

        const { data: links, error: findError } = await supabase
            .from(T)
            .select('id, collection_days, sequence_order')
            .eq('route_id', route_id)
            .eq('plan_month', plan_month);
        if (findError) throw new Error(findError.message);

        const uploaded = (d: string) => collection_days.includes(d);
        const overlapping = (links || []).filter(l => (l.collection_days || []).some(uploaded));
        const old = overlapping.filter(l => l.collection_days.every(uploaded)).map(l => l.id);
        const trimmed = overlapping.filter(l => !l.collection_days.every(uploaded));
        const last = Math.max(0, ...(links || []).map(l => l.sequence_order || 0));

        // Arrange facilities strictly according to their exact serial number order for this respective day list
        const sortedItemsWithHce = items.map((it: any, idx: number) => ({ it, hce_id: hce_ids[idx] }))
            .sort((a: any, b: any) => {
                const na = a.it.sl_no != null && !Number.isNaN(Number(a.it.sl_no)) ? Number(a.it.sl_no) : Infinity;
                const nb = b.it.sl_no != null && !Number.isNaN(Number(b.it.sl_no)) ? Number(b.it.sl_no) : Infinity;
                return na - nb;
            });

        const { error } = await supabase.from(T).insert(sortedItemsWithHce.map((entry: any, i: number) => ({
            route_id, company_id, hce_id: entry.hce_id, collection_days, collection_type, sequence_order: last + i + 1, sl_no: entry.it.sl_no ?? null, plan_month,
        })));
        if (error) throw new Error(error.message);

        if (old.length) {
            const { error: deleteError } = await supabase.from(T).delete().in('id', old);
            if (deleteError) throw new Error(deleteError.message);
        }
        const results = await Promise.all(trimmed.map(l => supabase
            .from(T)
            .update({ collection_days: l.collection_days.filter((d: string) => !uploaded(d)) })
            .eq('id', l.id)));
        const failed = results.find(r => r.error);
        if (failed?.error) throw new Error(failed.error.message);
        return { added: hce_ids.length, replaced: old.length, trimmed: trimmed.length };
    },

    /**
     * Undo a month's start (started by mistake): its plan is removed, so the
     * month shows the plan before it again. Only the newest plan, never the
     * first one, and only while no collection is saved in that month.
     */
    undoStartMonth: async ({ company_id, plan_month }: any, user: any) => {
        if (!isRoutePlanner(user)) throw httpError(403, 'Only Admin and Manager Operations can undo a month’s start.');
        if (!company_id) throw httpError(400, 'company_id is required.');
        const month = monthStart(plan_month);
        const first = async (q: any) => { const { data, error } = await q.limit(1); if (error) throw new Error(error.message); return (data || [])[0]; };
        if (!(await first(supabase.from(T).select('id').eq('company_id', company_id).eq('plan_month', month)))) {
            throw httpError(409, `The ${monthName(month)} plan has not been started.`);
        }
        if (await first(supabase.from(T).select('id').eq('company_id', company_id).gt('plan_month', month))) {
            throw httpError(409, `A later month's plan is started: undo that one first.`);
        }
        if (!(await first(supabase.from(T).select('id').eq('company_id', company_id).lt('plan_month', month)))) {
            throw httpError(409, `The ${monthName(month)} plan is the first plan and cannot be removed.`);
        }
        const [yy, mm] = month.split('-').map(Number);
        const nextMonth = `${mm === 12 ? yy + 1 : yy}-${String(mm === 12 ? 1 : mm + 1).padStart(2, '0')}-01`;
        if (await first(supabase.from('keil_collection_headers').select('id').eq('company_id', company_id)
            .gte('collection_date', month).lt('collection_date', nextMonth))) {
            throw httpError(409, `Collections are already saved in ${monthName(month)}, so its plan stays. Change the plan instead.`);
        }
        const { error } = await supabase.from(T).delete().eq('company_id', company_id).eq('plan_month', month);
        if (error) throw new Error(error.message);
        return { plan_month: month };
    },

    /** Take a facility off a route; the SL NOs after it close the gap. */
    removeHce: async (id: string, user: any) => {
        const [link] = await linksOf([id]);
        if (link) {
            await assertWritable(user, link.company_id, link.plan_month);
            await closeGap(link);
        }
        const { error } = await supabase.from(T).delete().eq('id', id);
        if (error) throw new Error(error.message);
        return true;
    },

    /** Save a new route order: each link's sequence_order, and sl_no when given. */
    reorder: async (items: { id: string; sequence_order: number; sl_no?: number | null }[], user: any) => {
        if (!items.length) return true;
        const [link] = await linksOf(items.map(it => it.id));
        if (link) await assertWritable(user, link.company_id, link.plan_month);
        const results = await Promise.all(items.map(it => supabase
            .from(T)
            .update(it.sl_no === undefined ? { sequence_order: it.sequence_order } : { sequence_order: it.sequence_order, sl_no: it.sl_no })
            .eq('id', it.id)));
        const failed = results.find(r => r.error);
        if (failed?.error) throw new Error(failed.error.message);
        return true;
    },

    updateAssignment: async (id: string, updates: any, user: any) => {
        const [link] = await linksOf([id]);
        if (link) await assertWritable(user, link.company_id, link.plan_month);
        const { plan_month, route_id, company_id, position, ...allowed } = updates; // a link stays in its month and route here
        const { data, error } = await supabase
            .from(T)
            .update(allowed)
            .eq('id', id)
            .select()
            .single();

        if (error) throw new Error(error.message);
        return data;
    }
};
