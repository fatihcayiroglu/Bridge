package com.bridge.app;

import static org.junit.Assert.assertEquals;

import org.junit.Test;

/** #209 AN00: the debug stall control can never block for an unbounded time. */
public class MainThreadStallControlActivityTest {
    @Test
    public void stallIsBoundedToOneToThirtySeconds() {
        assertEquals(1_000L, MainThreadStallControlActivity.boundedStallMs(-5L));
        assertEquals(1_000L, MainThreadStallControlActivity.boundedStallMs(0L));
        assertEquals(7_000L, MainThreadStallControlActivity.boundedStallMs(7_000L));
        assertEquals(20_000L, MainThreadStallControlActivity.boundedStallMs(20_000L));
        assertEquals(30_000L, MainThreadStallControlActivity.boundedStallMs(Long.MAX_VALUE));
    }
}
