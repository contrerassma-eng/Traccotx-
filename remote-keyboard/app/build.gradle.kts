import org.jetbrains.kotlin.gradle.dsl.JvmTarget

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "cl.tracco.remotekeyboard"
    compileSdk = 34

    defaultConfig {
        applicationId = "cl.tracco.remotekeyboard"
        minSdk = 21
        targetSdk = 34
        versionCode = 1
        versionName = "1.0"
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            // Sin firma propia: el APK de release queda sin firmar. Para instalar en el
            // proyector basta con el APK debug (firmado automáticamente).
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    lint {
        abortOnError = false
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    // Servidor HTTP embebido (sirve la página web y la API en la red local).
    implementation("org.nanohttpd:nanohttpd:2.3.1")
    // Generación del código QR con la URL de conexión.
    implementation("com.google.zxing:core:3.5.3")
}
