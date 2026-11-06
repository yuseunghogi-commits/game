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

    signingConfigs {
        getByName("debug") {
            // CI는 매번 같은 키로 서명하도록 키 파일 위치를 넘긴다(비밀번호·별칭은 디버그 키 기본값).
            System.getenv("DEVTOOLS_SIGNING_STORE")?.let { storeFile = file(it) }
        }
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
