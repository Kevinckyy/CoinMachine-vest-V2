"""A center acknowledges the exact node snapshot before receiving sparse changes to it."""
import uuid
from .protocol import ident, require


def differences(before, after, path, changes):
    if type(before) is type(after):
        if before == after:
            return
        if isinstance(after, dict) and before.keys() == after.keys():
            for key, value in after.items():
                differences(before[key], value, [*path, key], changes)
            return
        if isinstance(after, list) and len(before) == len(after):
            for index, value in enumerate(after):
                differences(before[index], value, [*path, index], changes)
            return
    changes.append([path, after])


class StatusFeed:
    def __init__(self, keep=1):
        self.keep = keep
        self.baselines = {}

    def response(self, snapshot, since):
        # Called under the bridge DB lock. Unversioned status readers do not advance this cursor.
        if since is None:
            return snapshot
        base = self.baselines.get(since)
        cursor = uuid.uuid4().hex
        if base is not None and base.keys() == snapshot.keys():
            changes = []
            differences(base, snapshot, [], changes)
            if not changes:
                cursor = since
            response = {"base": since, "status_cursor": cursor, "changes": changes,
                        **{k:snapshot[k] for k in ("node_id","instance_id") if k in snapshot}}
        else:
            response = {**snapshot, "status_cursor": cursor}
        self.baselines[cursor] = snapshot
        if len(self.baselines) > self.keep:
            del self.baselines[next(iter(self.baselines))]
        return response


def unpack(previous, response):
    if "base" not in response:
        return response
    require(previous.get("status_cursor") == response["base"] and
            all(previous.get(k) == response.get(k) for k in ("node_id", "instance_id")),
            "节点增量与上次同步不匹配", 502)
    cursor = ident(response.get("status_cursor"))
    changes = response.get("changes")
    require(isinstance(changes, list), "节点增量格式无效", 502)
    for change in changes:
        require(isinstance(change, list) and len(change) == 2, "节点增量格式无效", 502)
        path, value = change
        require(isinstance(path, list) and 0 < len(path) <= 24 and path[0] not in ("instance_id","node_id","status_cursor"),
                "节点增量路径无效", 502)
        parent = previous
        for depth, key in enumerate(path):
            require((isinstance(parent, dict) and isinstance(key, str) and key in parent) or
                    (isinstance(parent, list) and type(key) is int and 0 <= key < len(parent)),
                    "节点增量路径不存在", 502)
            if depth == len(path)-1:
                parent[key] = value
            else:
                parent = parent[key]
    previous["status_cursor"] = cursor
    return previous
