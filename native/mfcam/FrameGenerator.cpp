#include "pch.h"
#include "Undocumented.h"
#include "Tools.h"
#include "EnumNames.h"
#include "MFTools.h"
#include "FrameGenerator.h"

HRESULT FrameGenerator::EnsureRenderTarget(UINT width, UINT height)
{
	_width = width;
	_height = height;
	_frame = 0;
	_pixels.assign((size_t)width * height * 4, 0);
	FillStandby();
	EnsureShared();
	return S_OK;
}

// Creates (inside the Frame Server service) or opens the shared frame memory.
// Retried at most once a second while it isn't available.
void FrameGenerator::EnsureShared()
{
	if (_shared) return;
	auto now = GetTickCount64();
	if (_lastOpenAttempt && now - _lastOpenAttempt < 1000) return;
	_lastOpenAttempt = now;

	// SYSTEM, Local Service and admins get full access; signed-in users may
	// read and write, which is what the app's helper needs.
	PSECURITY_DESCRIPTOR sd = nullptr;
	SECURITY_ATTRIBUTES sa{ sizeof(sa), nullptr, FALSE };
	if (ConvertStringSecurityDescriptorToSecurityDescriptorW(
		L"D:P(A;;GA;;;SY)(A;;GA;;;LS)(A;;GA;;;BA)(A;;GRGW;;;AU)", SDDL_REVISION_1, &sd, nullptr))
	{
		sa.lpSecurityDescriptor = sd;
	}

	auto size = EclipseSharedFrameSize();
	_mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, sd ? &sa : nullptr, PAGE_READWRITE,
		(DWORD)((ULONGLONG)size >> 32), (DWORD)(size & 0xFFFFFFFF), ECLIPSE_SHARED_FRAME_NAME);
	if (sd) LocalFree(sd);

	// Outside the service (no right to create Global objects) just open it.
	if (!_mapping)
	{
		_mapping = OpenFileMappingW(FILE_MAP_READ, FALSE, ECLIPSE_SHARED_FRAME_NAME);
	}
	if (!_mapping)
	{
		WINTRACE(L"FrameGenerator shared memory unavailable: %u", GetLastError());
		return;
	}

	_shared = (EclipseSharedFrame*)MapViewOfFile(_mapping, FILE_MAP_READ, 0, 0, size);
	if (!_shared)
	{
		CloseHandle(_mapping);
		_mapping = nullptr;
	}
}

// Copies the latest frame the app wrote, if there is a fresh one.
bool FrameGenerator::ReadShared()
{
	EnsureShared();
	if (!_shared) return false;
	if (_shared->magic != ECLIPSE_FRAME_MAGIC || _shared->width != _width || _shared->height != _height)
		return false;
	if (GetTickCount64() - (ULONGLONG)_shared->writtenAt > ECLIPSE_FRAME_STALE_MS)
		return false;

	// Seqlock read: retry if the writer was mid-frame.
	for (int attempt = 0; attempt < 3; attempt++)
	{
		auto before = _shared->sequence;
		if (before & 1) { YieldProcessor(); continue; }
		MemoryBarrier();
		CopyMemory(_pixels.data(), EclipseSharedFramePixels(_shared), _pixels.size());
		MemoryBarrier();
		if (_shared->sequence == before) return true;
	}
	return true; // a slightly torn frame beats a frozen one
}

void FrameGenerator::FillStandby()
{
	// Dark purple, matching the app's standby screen background.
	auto px = (UINT32*)_pixels.data();
	const UINT32 color = 0xFF1B1030; // BGRA little-endian: B=0x30 G=0x10 R=0x1B
	for (size_t i = 0, n = _pixels.size() / 4; i < n; i++) px[i] = color;
}

HRESULT FrameGenerator::Generate(IMFSample* sample, REFGUID format, IMFSample** outSample)
{
	RETURN_HR_IF_NULL(E_POINTER, sample);
	RETURN_HR_IF_NULL(E_POINTER, outSample);
	*outSample = nullptr;

	if (!ReadShared() && !(_frame % 30))
	{
		// Nothing fresh from the app: fall back to standby (kept the last
		// frame for up to a second so brief hiccups don't flash).
		FillStandby();
	}

	wil::com_ptr_nothrow<IMFMediaBuffer> mediaBuffer;
	RETURN_IF_FAILED(sample->GetBufferByIndex(0, &mediaBuffer));
	wil::com_ptr_nothrow<IMF2DBuffer2> buffer2D;
	BYTE* scanline;
	LONG pitch;
	BYTE* start;
	DWORD length;
	RETURN_IF_FAILED(mediaBuffer->QueryInterface(IID_PPV_ARGS(&buffer2D)));
	RETURN_IF_FAILED(buffer2D->Lock2DSize(MF2DBuffer_LockFlags_Write, &scanline, &pitch, &start, &length));

	HRESULT hr = S_OK;
	const LONG srcStride = (LONG)_width * 4;
	if (format == MFVideoFormat_NV12)
	{
		hr = RGB32ToNV12(_pixels.data(), (ULONG)_pixels.size(), srcStride, _width, _height, scanline, length, pitch);
	}
	else
	{
		// RGB32: copy row by row; pitch may differ from the source stride.
		for (UINT y = 0; y < _height; y++)
		{
			CopyMemory(scanline + (LONG_PTR)pitch * y, _pixels.data() + (size_t)srcStride * y, srcStride);
		}
	}

	buffer2D->Unlock2D();
	if (SUCCEEDED(hr))
	{
		_frame++;
		sample->AddRef();
		*outSample = sample;
	}
	return hr;
}
