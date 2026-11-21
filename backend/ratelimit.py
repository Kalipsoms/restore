import time
from collections import deque


class RateLimiter:
    """In-memory sliding-window limiter. The API runs as a single process."""

    def __init__(self, clock=time.monotonic, max_keys=20000):
        self.clock = clock
        self.max_keys = max_keys
        self.hits = {}

    def retry_after(self, key, limit, window):
        """Record a hit. Return 0 when allowed, otherwise the seconds to wait."""
        now = self.clock()
        hits = self.hits.get(key)
        if hits is None:
            if len(self.hits) >= self.max_keys:
                self.prune(now)
            hits = self.hits[key] = deque()
        while hits and hits[0][0] <= now:
            hits.popleft()
        if len(hits) >= limit:
            return max(1, int(hits[0][0] - now + 0.999))
        hits.append((now + window,))
        return 0

    def prune(self, now):
        for key in [key for key, hits in self.hits.items() if not hits or hits[-1][0] <= now]:
            del self.hits[key]
        if len(self.hits) >= self.max_keys:
            self.hits.clear()
