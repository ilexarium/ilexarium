import { Component } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { lucideServer } from '@ng-icons/lucide';
import { TranslatePipe } from '@ngx-translate/core';
import { HlmSidebarImports } from '@ui/sidebar';
import { APP_NAME } from '../../core/page-title/page-title';
import { NAV_ICONS, NAVIGATION } from '../navigation';

/**
 * The app's navigation. Collapses to icons (with tooltips) on medium screens and when toggled;
 * a slide-out sheet on phones, closed again when a page is chosen.
 */
@Component({
  selector: 'app-sidebar',
  imports: [HlmSidebarImports, NgIcon, RouterLink, RouterLinkActive, TranslatePipe],
  providers: [provideIcons({ ...NAV_ICONS, lucideServer })],
  templateUrl: './app-sidebar.html',
})
export class AppSidebar {
  protected readonly appName = APP_NAME;
  protected readonly navigation = NAVIGATION;
}
