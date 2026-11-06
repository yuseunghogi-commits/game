plugins {
    id("com.android.application")
}

android {
    namespace = "io.github.yuseunghogi.devbrowser"
    compileSdk = 35

    defaultConfig {
        applicationId = "io.github.yuseunghogi.devbrowser"
        minSdk = 24
        targetSdk = 35
        versionCode = 1
        versionName = "1.0.0"
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        buildConfig = false
    }
}

dependencies {
    // 문서 시작 시점 스크립트 주입(WebViewCompat.addDocumentStartJavaScript)
    implementation("androidx.webkit:webkit:1.12.1")

    testImplementation("junit:junit:4.13.2")
}
