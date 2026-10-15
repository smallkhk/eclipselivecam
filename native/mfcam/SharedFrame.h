// Frame hand-off between eclipse-vcam.exe (writer, runs as the user) and this
// media source (reader, runs inside Windows' Frame Server service).
//
// The media source creates the mapping, because only the service is allowed
// to create objects in the Global namespace; the helper opens it for writing.
// Layout: header followed by width*height BGRA pixels, top-down.
//
// Shared by native/eclipse-vcam.cpp and native/mfcam.
#pragma once
#include <windows.h>

#define ECLIPSE_SHARED_FRAME_NAME L"Global\\EclipseLiveCam_Frames"
#define ECLIPSE_FRAME_WIDTH 1280
#define ECLIPSE_FRAME_HEIGHT 720
#define ECLIPSE_FRAME_MAGIC 0x31434C45u  // "ELC1"
// A frame older than this means the app stopped sending; show standby.
#define ECLIPSE_FRAME_STALE_MS 3000

struct EclipseSharedFrame
{
	UINT32 magic;
	UINT32 width;
	UINT32 height;
	// Seqlock: odd while the writer is copying a frame, even when stable.
	volatile LONG sequence;
	// GetTickCount64() of the last completed write.
	volatile LONGLONG writtenAt;
	// BGRA pixels follow.
};

inline SIZE_T EclipseSharedFrameSize()
{
	return sizeof(EclipseSharedFrame) + (SIZE_T)ECLIPSE_FRAME_WIDTH * ECLIPSE_FRAME_HEIGHT * 4;
}

inline BYTE* EclipseSharedFramePixels(EclipseSharedFrame* frame)
{
	return reinterpret_cast<BYTE*>(frame) + sizeof(EclipseSharedFrame);
}
