plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

dependencies {
    // 숨겨진 시스템 API(ServiceManager) 접근용 — 세션 탐색에 사용
    implementation("org.lsposed.hiddenapibypass:hiddenapibypass:4.3")
    // PC 없이 폰에서 ADB 권한(DUMP)을 받기 위한 Shizuku
    implementation("dev.rikka.shizuku:api:13.1.5")
    implementation("dev.rikka.shizuku:provider:13.1.5")
}

android {
    namespace = "com.spatialsound.app"
    compileSdk = 34

    defaultConfig {
        applicationId = "com.spatialsound.app"
        minSdk = 26
        targetSdk = 34
        versionCode = 2
        versionName = "1.1"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // 개인 사용용: 디버그 키로 서명해서 바로 설치 가능하게 함
            signingConfig = signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }
}
