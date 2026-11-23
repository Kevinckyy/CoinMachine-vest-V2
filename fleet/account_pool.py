"""Account-pool allocation and batch direction from coinMachine-vest, adapted to node-local state."""

import math

from .protocol import Problem as ValidationError

POOL_STRATEGIES = {
    'random': '全随机选择',
    'same_stage': '每批同阶段',
    'dynamic': '动态分配',
}

LIVE = 2
MAX_POOL_SIZE = 1_000_000
POOL_DEFAULTS = dict(
    pool_strategy='random', same_stage_full_batch=True, pool_limits_enabled=False,
    exam_pool_limit='infinity', live_pool_limit=10, dynamic_reserve_low=3,
    dynamic_reserve_high=6, dynamic_live_target=10, dynamic_exam_slots=None,
)


def pool_integer(value, label, minimum=1):
    if (isinstance(value, bool) or not isinstance(value, (int, float))
        or not minimum <= value <= MAX_POOL_SIZE or not math.isfinite(value) or int(value) != value):
        raise ValidationError(f'{label}必须为 {minimum}–{MAX_POOL_SIZE} 之间的整数')
    return int(value)


def pool_settings(raw, *, initial_phase=None):
    config = {key: raw.get(key, default) for key, default in POOL_DEFAULTS.items()}
    if not isinstance(config['pool_strategy'], str) or config['pool_strategy'] not in POOL_STRATEGIES:
        raise ValidationError('请选择有效的账号池策略')
    for key, label in (('pool_limits_enabled', '账号池限制'), ('same_stage_full_batch', '不足一批时顺延')):
        if not isinstance(config[key], bool):
            raise ValidationError(f'{label}必须为布尔值')
    for key, label in (('exam_pool_limit', '考试号池上限'), ('live_pool_limit', 'Live号池上限')):
        config[key] = 'infinity' if config[key] in ('∞', 'infinity') else pool_integer(config[key], label)
    dynamic = config['pool_strategy'] == 'dynamic'
    finite_live = config['pool_limits_enabled'] and config['live_pool_limit'] != 'infinity'
    use_reserve = dynamic and finite_live and initial_phase != 'live'
    for key, label, minimum in (('dynamic_reserve_low', '候补下限', 1), ('dynamic_reserve_high', '候补恢复线', 2),
                                ('dynamic_live_target', 'Live 目标存量', 1)):
        required = dynamic and not finite_live if key == 'dynamic_live_target' else use_reserve
        try:
            config[key] = pool_integer(config[key], label, minimum)
        except ValidationError:
            if required:
                raise
            config[key] = POOL_DEFAULTS[key]
    if config['dynamic_reserve_high'] <= config['dynamic_reserve_low']:
        if use_reserve:
            raise ValidationError('候补恢复线必须高于候补下限')
        for key in ('dynamic_reserve_low', 'dynamic_reserve_high'):
            config[key] = POOL_DEFAULTS[key]
    return config


def pool_limit(config, kind):
    if not config['pool_limits_enabled']:
        return math.inf
    value = config[f'{kind}_pool_limit']
    return math.inf if value == 'infinity' else value


def dynamic_exam_slots(config, batch_size):
    value = config['dynamic_exam_slots']
    if config['pool_strategy'] != 'dynamic' or batch_size < 2 or config.get('initial_phase') == 'live' or value is None:
        return None
    if (isinstance(value, bool) or not isinstance(value, (int, float))
        or not 1 <= value < batch_size or int(value) != value):
        raise ValidationError(f'补位时每批考试名额必须为 1–{batch_size - 1} 之间的整数')
    return int(value)


def reserve_thresholds(config):
    high = min(config['dynamic_reserve_high'], pool_limit(config, 'exam'))
    return min(config['dynamic_reserve_low'], high), high


def needs_refill(config, live_count, waiting_count, refilling):
    limit = pool_limit(config, 'live')
    if limit == math.inf:
        return live_count < config['dynamic_live_target']
    low, high = reserve_thresholds(config)
    return live_count < limit or waiting_count < (high if refilling else low)


def exam_quota(size, completed_batches, exam_slots=None, batch_size=None):
    if exam_slots is not None:
        if size == 1:
            return int(completed_batches % batch_size < exam_slots)
        return min(size - 1, (exam_slots * size + batch_size - 1) // batch_size)
    if size == 1:
        return int(completed_batches % 3 != 2)
    return min(size - 1, (2 * size + 2) // 3)


def stage_allocations(policy, counts, size, order, *, full_stage_batch, refill, completed_batches,
                      exam_slots=None, batch_size=None):
    """Assign slots in priority order. The caller samples IDs within each stage."""
    allocated = [0, 0, 0]
    if policy == 'same_stage':
        minimum = size if full_stage_batch else 1
        stage = next(phase for phase in order if counts[phase] >= minimum)
        allocated[stage] = min(size, counts[stage])
        return allocated

    def allocate(phases, slots):
        for phase in phases:
            amount = min(slots, counts[phase] - allocated[phase])
            allocated[phase] += amount
            slots -= amount
            if not slots:
                break

    if policy == 'dynamic' and refill:
        reserved = exam_quota(size, completed_batches, exam_slots, batch_size)
        allocate((phase for phase in order if phase != LIVE), reserved)
        allocate((LIVE,), size - reserved)
    allocate(order, size - sum(allocated))
    return allocated


PHASES = ("1/2", "2/2", "live")
DEFAULT_ACCOUNT_PRIORITY = ("live", "2/2", "1/2")


def choose_batch_side(strategy_id, rng, preferences):
    """Resolve one side for all members of one symbol's batch."""
    if strategy_id != 'random_entry':
        raise ValueError('未知自动策略')
    choices = set(preferences)
    if not choices or not choices.issubset({'buy', 'sell', 'random'}):
        raise ValueError('批次方向参数无效')
    fixed = choices - {'random'}
    if len(fixed) > 1:
        raise ValueError('同批同品种必须同向：考核号与 Live 的固定方向冲突，请改为一致方向或随机')
    return next(iter(fixed)) if fixed else rng.choice(('buy', 'sell'))


def normalize_account_priority(order):
    if (not isinstance(order, (list, tuple)) or len(order) != 3
            or any(phase not in DEFAULT_ACCOUNT_PRIORITY for phase in order) or len(set(order)) != 3):
        raise ValueError('账号优先级须包含 Live、2/2、1/2，各出现一次')
    return list(order)


def account_priority_ranks(config):
    if not config['live_priority']:
        return {}
    return {phase: rank for rank, phase in enumerate(config['account_priority_order'])}


def choose_ranked_batch(rng, candidates, size, rank):
    groups = {}
    for candidate in candidates:
        groups.setdefault(rank(candidate), []).append(candidate)
    picked = []
    for priority in sorted(groups):
        group = groups[priority]
        picked.extend(rng.sample(group, min(size - len(picked), len(group))))
        if len(picked) == size:
            break
    return picked


def choose_pool_batch(state, config, accounts, eligible, phase_of, ranks, rng):
    policy = config.get('pool_strategy', 'random')
    batch_size = size = config['batch_size']
    if policy == 'random' and not config.get('pool_limits_enabled'):
        if len(eligible) < size:
            return []
        if ranks:
            return choose_ranked_batch(rng, eligible, size, lambda aid: ranks[phase_of(accounts[aid])])
        return rng.sample(eligible, size)

    full_stage = policy == 'same_stage' and config['same_stage_full_batch']
    phases = {aid: PHASES.index(phase_of(account)) for aid, account in accounts.items()}
    ready = [aid for aid in eligible if aid in phases]
    live = [aid for aid, phase in phases.items() if phase == LIVE and accounts[aid]['status'] == 'active'
            and accounts[aid].get('strategy_lock_source') not in ('manual', 'live_default')]
    live_set = set(live)
    admitted = [aid for aid in state.get('pool_live_ids', []) if aid in live_set]
    waiting = sorted((aid for aid in ready if aid in live_set and aid not in admitted),
                     key=lambda aid: accounts[aid].get('phase_started_at') or 0)
    slots = int(min(len(waiting), max(0, pool_limit(config, 'live') - len(admitted))))
    admitted.extend(waiting[:slots])
    waiting = waiting[slots:]
    live_ids = set(admitted)
    exam = [aid for aid in state.get('pool_exam_ids', []) if aid in accounts and aid not in live_ids]
    state.update(pool_live_ids=admitted, pool_waiting_live_ids=waiting, pool_exam_ids=exam)
    refilling = policy == 'dynamic' and needs_refill(config, len(admitted), len(waiting), state.get('pool_refilling', True))
    state['pool_refilling'] = refilling

    existing = [[], [], [aid for aid in ready if aid in live_ids]]
    spare = [[], [], []]
    exam_ids = set(exam)
    for aid in ready:
        phase = phases[aid]
        if phase != LIVE:
            (existing if aid in exam_ids else spare)[phase].append(aid)

    order = sorted(range(len(PHASES)), key=lambda phase: ranks[PHASES[phase]]) if ranks else list(range(len(PHASES)))
    exam_room = int(min(len(ready), max(0, pool_limit(config, 'exam') - len(exam))))
    if policy == 'same_stage':
        for phase in (0, 1):
            limit = max(0, size - len(existing[phase])) if full_stage else size
            existing[phase].extend(rng.sample(spare[phase], min(exam_room, limit, len(spare[phase]))))
    else:
        fresh = spare[0] + spare[1]
        if len(fresh) > exam_room:
            fresh = (choose_ranked_batch(rng, fresh, exam_room, lambda aid: ranks[PHASES[phases[aid]]])
                     if ranks else rng.sample(fresh, exam_room))
        for aid in fresh:
            existing[phases[aid]].append(aid)

    counts = [len(group) for group in existing]
    if full_stage and max(counts) < size:
        return []
    size = min(size, sum(counts))
    if not size:
        return []
    if not ranks:
        if policy == 'random':
            return rng.sample([aid for group in existing for aid in group], size)
        rng.shuffle(order)
    allocations = stage_allocations(policy, counts, size, order, full_stage_batch=full_stage,
                                    refill=refilling, completed_batches=state['batch'],
                                    exam_slots=config.get('dynamic_exam_slots'), batch_size=batch_size)
    batch = [aid for phase in order for aid in rng.sample(existing[phase], allocations[phase])]
    if not ranks and policy == 'dynamic':
        rng.shuffle(batch)
    return batch
