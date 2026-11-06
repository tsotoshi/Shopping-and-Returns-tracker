#!/usr/bin/env python3
"""
Reads your recent Amazon orders with the open-source amazon-orders library
(https://github.com/alexdlaird/amazon-orders) and prints them as JSON for the
tracker to use. The tracker runs this during sync; you don't run it yourself.

- It only READS your order history. It never buys, changes, or cancels anything.
- It uses the sign-in you made once with:   .venv/bin/amazon-orders login --browser
  Your password is never stored; only that saved session is used.
- It never waits for typing. If Amazon wants you to sign in again, it prints
  {"ok": false, "error": "signin_required"} and exits.
"""
import argparse
import json
import sys


def emit(obj):
    sys.stdout.write(json.dumps(obj, default=str))
    sys.stdout.flush()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--time-filter", default="last30", choices=["last30", "months-3"])
    # Item prices are only on each order's detail page (one extra page load per order),
    # so fetch details just for orders still missing prices, and only a few per run.
    parser.add_argument("--details-limit", type=int, default=15)
    parser.add_argument("--skip-details", default="", help="comma-separated order numbers that already have prices")
    args = parser.parse_args()

    try:
        from amazonorders.exception import AmazonOrdersAuthError, AmazonOrdersError
        from amazonorders.orders import AmazonOrders
        from amazonorders.session import AmazonSession, IODefault
    except ImportError:
        emit({"ok": False, "error": "not_installed"})
        return 0

    class NoTyping(IODefault):
        """Messages go to stderr (stdout is reserved for JSON); any request for input means sign-in is needed."""

        def echo(self, msg, **kwargs):
            print(msg, file=sys.stderr)

        def prompt(self, msg, type=None, **kwargs):
            raise AmazonOrdersAuthError("Amazon asked for sign-in input")

    try:
        session = AmazonSession(io=NoTyping())
        if not session.auth_cookies_stored():
            emit({"ok": False, "error": "signin_required"})
            return 0
        session.login()  # reuses the saved session; no password involved
        amazon_orders = AmazonOrders(session)
        orders = amazon_orders.get_orders(time_filter=args.time_filter)
        skip = {s for s in args.skip_details.split(",") if s}
        detailed = 0
        for i, order in enumerate(orders):
            if detailed >= args.details_limit:
                break
            needs_prices = any(item.price is None for item in (order.items or []))
            if not needs_prices or order.cancelled or order.order_number in skip:
                continue
            try:
                orders[i] = amazon_orders.get_order(order.order_number, clone=order)
                detailed += 1
            except AmazonOrdersAuthError:
                raise
            except AmazonOrdersError as e:
                print(f"Could not load details for {order.order_number}: {e}", file=sys.stderr)
        emit({"ok": True, "detailed": detailed, "orders": [o.to_dict(exclude_none=True) for o in orders]})
    except AmazonOrdersAuthError as e:
        emit({"ok": False, "error": "signin_required", "detail": str(e)})
    except AmazonOrdersError as e:
        emit({"ok": False, "error": "amazon_error", "detail": str(e)})
    except Exception as e:  # report, don't crash the tracker
        emit({"ok": False, "error": "unexpected", "detail": f"{type(e).__name__}: {e}"})
    return 0


if __name__ == "__main__":
    sys.exit(main())
