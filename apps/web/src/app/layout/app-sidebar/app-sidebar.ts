import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideServer } from '@ng-icons/lucide';
import { HlmSidebarImports } from '@ui/sidebar';
import { APP_NAME } from '../../core/page-title/page-title';
import { NAV_ICONS, NAVIGATION } from '../navigation';

/**
 * The app's navigation. Collapses to icons (with tooltips) on medium screens and when toggled;
 * a slide-out sheet on phones, closed again when a page is chosen.
 */
@Component({
  selector: 'app-sidebar',
  imports: [HlmSidebarImports, NgIcon, RouterLink, RouterLinkActive],
  providers: [provideIcons({ ...NAV_ICONS, lucideServer })],
  template: `
    <hlm-sidebar
      collapsible="icon"
      srOnlySheetTitle="Navigation"
      srOnlySheetDescription="The pages of the app."
    >
      <div hlmSidebarHeader>
        <ul hlmSidebarMenu>
          <li hlmSidebarMenuItem>
            <a
              hlmSidebarMenuButton
              size="lg"
              routerLink="/"
              [tooltip]="appName"
              closeMobileSidebarOnClick
            >
              <span
                class="bg-sidebar-primary text-sidebar-primary-foreground flex size-8 items-center justify-center rounded-lg"
                aria-hidden="true"
              >
                <ng-icon name="lucideServer" />
              </span>
              <span class="font-semibold">{{ appName }}</span>
            </a>
          </li>
        </ul>
      </div>
      <nav hlmSidebarContent aria-label="Main">
        @for (group of navigation; track $index) {
          <div hlmSidebarGroup>
            @if (group.label) {
              <div hlmSidebarGroupLabel>{{ group.label }}</div>
            }
            <ul hlmSidebarMenu>
              @for (item of group.items; track item.link) {
                <li hlmSidebarMenuItem>
                  <a
                    hlmSidebarMenuButton
                    [routerLink]="item.link"
                    routerLinkActive
                    #active="routerLinkActive"
                    [routerLinkActiveOptions]="{ exact: !!item.exact }"
                    ariaCurrentWhenActive="page"
                    [isActive]="active.isActive"
                    [tooltip]="item.label"
                    closeMobileSidebarOnClick
                    class="max-md:h-11"
                  >
                    <ng-icon [name]="item.icon" aria-hidden="true" />
                    <span>{{ item.label }}</span>
                  </a>
                </li>
              }
            </ul>
          </div>
        }
      </nav>
    </hlm-sidebar>
  `,
})
export class AppSidebar {
  protected readonly appName = APP_NAME;
  protected readonly navigation = NAVIGATION;
}
