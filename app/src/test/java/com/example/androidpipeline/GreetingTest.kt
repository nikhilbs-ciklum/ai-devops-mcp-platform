package com.example.androidpipeline

import org.junit.Assert.assertEquals
import org.junit.Test

class GreetingTest {
    @Test
    fun createsGreeting() {
        assertEquals("Hello, Demo!", Greeting.message("Android"))
    }

    @Test
    fun trimsSurroundingWhitespace() {
        assertEquals("Hello, Android!", Greeting.message("  Android  "))
    }

    @Test(expected = IllegalArgumentException::class)
    fun rejectsBlankNames() {
        Greeting.message("   ")
    }
}
