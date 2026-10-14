// eclipse-vcam.exe — feeds the AI output from the EclipseLiveCam app into the
// "EclipseLiveCam" virtual camera (a rebranded softcam DirectShow filter).
//
// Usage:
//   eclipse-vcam.exe <softcam.dll> <width> <height> <fps>
//
// The app writes raw RGBA frames (width * height * 4 bytes each) to stdin.
// Each one is converted to the top-down BGR layout softcam expects and sent to
// the camera. Closing stdin (or the app exiting) removes the camera cleanly.
//
// stdout reports one status line: "READY", or "ERROR <reason>".

#include <windows.h>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <vector>

typedef void* scCamera;
typedef scCamera (__cdecl *CreateCameraFn)(int width, int height, float framerate);
typedef void     (__cdecl *DeleteCameraFn)(scCamera camera);
typedef void     (__cdecl *SendFrameFn)(scCamera camera, const void* image_bits);

static int fail(const char* reason, int code)
{
    std::printf("ERROR %s\n", reason);
    std::fflush(stdout);
    return code;
}

static bool readFull(HANDLE in, uint8_t* buf, size_t size)
{
    while (size > 0)
    {
        DWORD got = 0;
        DWORD want = size > 0x10000000 ? 0x10000000 : (DWORD)size;
        if (!ReadFile(in, buf, want, &got, nullptr) || got == 0) return false;
        buf += got;
        size -= got;
    }
    return true;
}

int main(int argc, char** argv)
{
    if (argc != 5) return fail("usage: eclipse-vcam.exe <softcam.dll> <width> <height> <fps>", 1);

    const int width = std::atoi(argv[2]);
    const int height = std::atoi(argv[3]);
    const float fps = (float)std::atof(argv[4]);
    // softcam requires dimensions that are a multiple of four.
    if (width < 16 || height < 16 || width > 3840 || height > 2160 || width % 4 || height % 4)
        return fail("bad-size", 1);

    HMODULE dll = LoadLibraryA(argv[1]);
    if (!dll) return fail("dll-not-found", 2);
    auto createCamera = (CreateCameraFn)GetProcAddress(dll, "scCreateCamera");
    auto deleteCamera = (DeleteCameraFn)GetProcAddress(dll, "scDeleteCamera");
    auto sendFrame = (SendFrameFn)GetProcAddress(dll, "scSendFrame");
    if (!createCamera || !deleteCamera || !sendFrame) return fail("dll-invalid", 2);

    // Fails if another copy of the app already owns the camera.
    scCamera cam = createCamera(width, height, fps);
    if (!cam) return fail("camera-busy", 3);

    std::printf("READY\n");
    std::fflush(stdout);

    const size_t pixels = (size_t)width * height;
    std::vector<uint8_t> rgba(pixels * 4);
    std::vector<uint8_t> bgr(pixels * 3);
    HANDLE in = GetStdHandle(STD_INPUT_HANDLE);

    while (readFull(in, rgba.data(), rgba.size()))
    {
        const uint8_t* s = rgba.data();
        uint8_t* d = bgr.data();
        for (size_t i = 0; i < pixels; i++, s += 4, d += 3)
        {
            d[0] = s[2];
            d[1] = s[1];
            d[2] = s[0];
        }
        sendFrame(cam, bgr.data());
    }

    deleteCamera(cam);
    return 0;
}
