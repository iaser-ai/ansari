import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { config } from '@/lib/config';

const requestSchema = z.object({
  platform: z.string().min(1),
  native_application_version: z.string(),
  native_build_version: z.string(),
});

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json();
    const parseResult = requestSchema.safeParse(body);
    if (!parseResult.success) {
      const errors = parseResult.error.issues.map((i) => i.message).join(', ');
      return NextResponse.json({ detail: errors }, { status: 400 });
    }

    const { platform, native_build_version } = parseResult.data;
    const { maintenanceMode, ios, android } = config.appVersion;

    // Web platform only checks maintenance mode
    if (platform.toLowerCase() === 'web') {
      return NextResponse.json({
        maintenance_mode: maintenanceMode,
        update_available: false,
        force_update_required: false,
      });
    }

    // Mobile platforms: validate build version is an integer
    const buildVersion = parseInt(native_build_version, 10);
    if (isNaN(buildVersion)) {
      return NextResponse.json(
        { detail: 'Invalid native_build_version: must be a valid integer' },
        { status: 400 }
      );
    }

    let updateAvailable = false;
    let forceUpdateRequired = false;

    if (platform.toLowerCase() === 'ios') {
      if (buildVersion < ios.minimumBuild) {
        forceUpdateRequired = true;
      }
      if (buildVersion < ios.latestBuild) {
        updateAvailable = true;
      }
    } else if (platform.toLowerCase() === 'android') {
      if (buildVersion < android.minimumBuild) {
        forceUpdateRequired = true;
      }
      if (buildVersion < android.latestBuild) {
        updateAvailable = true;
      }
    } else {
      return NextResponse.json(
        { detail: "Invalid platform: must be 'web', 'ios', or 'android'" },
        { status: 400 }
      );
    }

    return NextResponse.json({
      maintenance_mode: maintenanceMode,
      update_available: updateAvailable,
      force_update_required: forceUpdateRequired,
    });
  } catch (error) {
    console.error('[app-check] error:', error);
    return NextResponse.json({ detail: 'Internal server error' }, { status: 500 });
  }
}
