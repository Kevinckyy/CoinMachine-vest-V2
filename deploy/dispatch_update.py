"""Submit one versioned deployment per node to the Vest center."""
import argparse
import json
import os
import sys
import time
import uuid
from urllib.error import HTTPError

from node_agent import ID, SHA, center_origin, checked, http


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--center", default=os.getenv("VEST_CENTER_URL"))
    parser.add_argument("--node", action="append", required=True, help="repeat for each target node")
    parser.add_argument("--revision", required=True)
    parser.add_argument("--request-id", default=str(uuid.uuid4()), help="reuse the printed ID when retrying")
    parser.add_argument("--wait", type=int, default=0, metavar="SECONDS", help="wait for actual browser confirmation")
    args = parser.parse_args()
    if args.wait < 0:
        parser.error("--wait must be zero or positive")
    token = os.getenv("VEST_ADMIN_TOKEN")
    if not token or not args.center:
        parser.error("set VEST_ADMIN_TOKEN and supply --center or VEST_CENTER_URL")
    try:
        base = center_origin(args.center)
        checked(SHA, args.revision)
        checked(ID, args.request_id)
        targets = {checked(ID, node): f"{base}/v1/nodes/{node}/updates/{args.request_id}" for node in args.node}
    except ValueError as err:
        parser.error(str(err))
    print("request_id =", args.request_id, flush=True)
    failed = False
    previous = {}
    pending = {}
    deadline = time.monotonic() + args.wait
    def observe(node, job):
        state = job["state"]
        if previous.get(node) != state:
            print(node, state, job.get("detail",""), flush=True)
            previous[node] = state
        return state

    for node, url in targets.items():
        try:
            state = observe(node, http(url, token, {"revision":args.revision}, "PUT"))
            if state in {"failed","rolled_back","cancelled","superseded"}:
                failed = True
            elif args.wait > 0 and state != "succeeded":
                pending[node] = url
        except (OSError, ValueError) as err:
            detail = str(err)
            if isinstance(err,HTTPError):
                with err:
                    try:
                        detail = json.loads(err.read(8192)).get("error") or detail
                    except (ValueError, AttributeError):
                        pass
            print(node, detail, file=sys.stderr)
            failed = True
    while pending and time.monotonic() < deadline:
        for node, url in list(pending.items()):
            try:
                state = observe(node, http(url, token))
            except (OSError,ValueError) as err:
                print(node, str(err), file=sys.stderr)
                continue
            if state in {"succeeded","failed","rolled_back","cancelled","superseded"}:
                del pending[node]
                failed |= state != "succeeded"
        if pending:
            time.sleep(min(2,max(0,deadline-time.monotonic())))
    if pending:
        print("Still awaiting confirmation:", ", ".join(pending), file=sys.stderr)
    return 1 if failed else 2 if pending else 0


if __name__ == "__main__":
    sys.exit(main())
