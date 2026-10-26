package com.example.androidpipeline

import android.app.Activity
import android.os.Bundle
import android.view.Gravity
import android.widget.TextView

class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        setContentView(TextView(this).apply {
            text = Greeting.message(getString(R.string.greeting_target))
            textSize = 28f
            gravity = Gravity.CENTER
        })
    }
}
