package com.example.androidpipeline

object Greeting {
    fun message(name: String): String {
        val trimmedName = name.trim()
        require(trimmedName.isNotEmpty()) { "Name must not be blank" }
        return "Hello, $trimmedName!"
    }
}
