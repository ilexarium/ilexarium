import { Body, Controller, Get, HttpCode, Ip, Post, UseFilters, UseGuards } from '@nestjs/common';
import {
  Authenticate,
  CurrentSession,
  CurrentUser,
  Public,
  type SessionRecord,
  SignInService,
} from '@nestjs/authentication';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import type { AuthStatusResponse, MeResponse, PublicUser, UserResponse } from '@ilex/shared';
import { UsersService } from '../users/users.service.js';
import { ChangePasswordDto, LoginDto, SetupDto } from './auth.dto.js';
import { AuthService } from './auth.service.js';
import { TooManyAttemptsFilter } from './too-many-attempts.filter.js';

/** Stricter per-IP limit for routes that check a password. */
const PASSWORD_ROUTE_LIMIT = { default: { limit: 10, ttl: 60_000 } };

@Controller('auth')
@UseGuards(ThrottlerGuard)
@UseFilters(TooManyAttemptsFilter)
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly users: UsersService,
    private readonly signIn: SignInService,
  ) {}

  @Public()
  @Get('status')
  async status(): Promise<AuthStatusResponse> {
    return { needsSetup: !(await this.users.hasAnyUser()) };
  }

  @Public()
  @Post('setup')
  @HttpCode(200)
  @Throttle(PASSWORD_ROUTE_LIMIT)
  async setup(@Body() body: SetupDto, @Ip() ip: string): Promise<UserResponse> {
    return { user: await this.auth.setup(body, ip) };
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @Throttle(PASSWORD_ROUTE_LIMIT)
  async login(@Body() body: LoginDto, @Ip() ip: string): Promise<UserResponse> {
    return { user: await this.auth.login(body, ip) };
  }

  /** Public: signing out with a session that already ended is not an error. */
  @Public()
  @Post('logout')
  @HttpCode(204)
  async logout(): Promise<void> {
    await this.signIn.signOut();
  }

  /** This browser's session too; sockets and log streams close with them. */
  @Post('logout-everywhere')
  @HttpCode(204)
  async logoutEverywhere(@CurrentUser() user: PublicUser): Promise<void> {
    await this.signIn.signOutEverywhere(user.id);
  }

  /** Optional: `{ user: null }` when signed out — never a 401, so startup can't misread it. */
  @Authenticate({ optional: true })
  @Get('me')
  me(@CurrentUser() user: PublicUser | null): MeResponse {
    return { user: user ?? null };
  }

  @Post('password')
  @HttpCode(204)
  @Throttle(PASSWORD_ROUTE_LIMIT)
  async changePassword(
    @Body() body: ChangePasswordDto,
    @CurrentUser() user: PublicUser,
    @CurrentSession() session: SessionRecord,
    @Ip() ip: string,
  ): Promise<void> {
    await this.auth.changePassword(user, session.id, body, ip);
  }
}
