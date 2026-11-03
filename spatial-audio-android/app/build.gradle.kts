plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

dependencies {
    // 숨겨진 시스템 API(ServiceManager) 접근용 — 세션 탐색에 사용
    implementation("org.lsposed.hiddenapibypass:hiddenapibypass:6.1")
    // 앱 하나로 권한 받기: 이 폰의 무선 디버깅(ADB)에 직접 페어링·접속 (Apache-2.0 로 사용)
    implementation("com.github.MuntashirAkon:libadb-android:3.1.1")
    // 무선 디버깅 페어링에 필요한 TLS 1.3 (+ 키 내보내기)
    implementation("org.conscrypt:conscrypt-android:2.5.3")
    // (선택) 이미 Shizuku 를 쓰는 사람은 그쪽으로도 권한을 받을 수 있게
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
        versionCode = 21
        versionName = "2.0"
    }

    // 서명 키: CI 가 SPATIAL_SIGN_STORE 로 항상 같은 키를 넘겨 준다 (덮어쓰기·자동 업데이트에 필요).
    // 없으면(직접 빌드) 이 컴퓨터의 디버그 키.
    val signStore = System.getenv("SPATIAL_SIGN_STORE")?.let { file(it) }?.takeIf { it.isFile }
    signingConfigs {
        create("stable") {
            if (signStore != null) {
                storeFile = signStore
                storePassword = System.getenv("SPATIAL_SIGN_PASS") ?: "spatialsound"
                keyAlias = "spatialsound"
                keyPassword = System.getenv("SPATIAL_SIGN_PASS") ?: "spatialsound"
            }
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            signingConfig = if (signStore != null) signingConfigs.getByName("stable") else signingConfigs.getByName("debug")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    kotlinOptions {
        jvmTarget = "17"
    }

    packaging {
        resources {
            // BouncyCastle 등 라이브러리의 중복 메타 파일
            excludes += setOf("META-INF/versions/9/OSGI-INF/MANIFEST.MF", "META-INF/DEPENDENCIES")
        }
    }
}
