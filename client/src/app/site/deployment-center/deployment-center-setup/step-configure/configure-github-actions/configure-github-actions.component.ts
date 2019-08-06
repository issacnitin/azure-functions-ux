import { Component } from '@angular/core';
import { DropDownElement } from 'app/shared/models/drop-down-element';
import { DeploymentCenterStateManager } from 'app/site/deployment-center/deployment-center-setup/wizard-logic/deployment-center-state-manager';
import { LogCategories, DeploymentCenterConstants } from 'app/shared/models/constants';
import { Observable } from 'rxjs/Observable';
import { ReplaySubject } from 'rxjs/ReplaySubject';
import { LogService } from 'app/shared/services/log.service';
import { OnDestroy } from '@angular/core/src/metadata/lifecycle_hooks';
import { Subject } from 'rxjs/Subject';
import { TranslateService } from '@ngx-translate/core';
import { RequiredValidator } from '../../../../../shared/validators/requiredValidator';
import { Url } from '../../../../../shared/Utilities/url';
import { ResponseHeader } from 'app/shared/Utilities/response-header';
import { GithubService } from '../../wizard-logic/github.service';

@Component({
  selector: 'app-configure-github-actions',
  templateUrl: './configure-github-actions.component.html',
  styleUrls: [
    './configure-github-actions.component.scss',
    '../step-configure.component.scss',
    '../../deployment-center-setup.component.scss',
  ],
})
export class ConfigureGithubActionsComponent implements OnDestroy {
  private reposStream = new ReplaySubject<string>();
  private _ngUnsubscribe$ = new Subject();
  private orgStream$ = new ReplaySubject<string>();
  private repoUrlToNameMap: { [key: string]: string } = {};

  public OrgList: DropDownElement<string>[] = [];
  public RepoList: DropDownElement<string>[] = [];
  public BranchList: DropDownElement<string>[] = [];

  public reposLoading = false;
  public branchesLoading = false;
  public permissionInfoLink = DeploymentCenterConstants.permissionsInfoLink;
  public selectedOrg = '';
  public selectedRepo = '';
  public selectedBranch = '';

  constructor(
    public wizard: DeploymentCenterStateManager,
    private _logService: LogService,
    private _translateService: TranslateService,
    private _githubService: GithubService
  ) {
    this.orgStream$.takeUntil(this._ngUnsubscribe$).subscribe(r => {
      this.reposLoading = true;
      this.fetchRepos(r);
    });

    this.reposStream.takeUntil(this._ngUnsubscribe$).subscribe(r => {
      this.branchesLoading = true;
      this.fetchBranches(r);
    });

    this.fetchOrgs();
    this.updateFormValidation();

    // if auth changes then this will force refresh the config data
    this.wizard.updateSourceProviderConfig$.takeUntil(this._ngUnsubscribe$).subscribe(r => {
      this.fetchOrgs();
    });
  }

  ngOnDestroy(): void {
    this._ngUnsubscribe$.next();
  }

  fetchOrgs() {
    return Observable.zip(this._githubService.fetchOrgs(), this._githubService.fetchUser(), (orgs, user) => ({
      orgs: orgs.json(),
      user: user.json(),
    })).subscribe(r => {
      const newOrgsList: DropDownElement<string>[] = [];
      newOrgsList.push({
        displayLabel: r.user.login,
        value: r.user.repos_url,
      });

      r.orgs.forEach(org => {
        newOrgsList.push({
          displayLabel: org.login,
          value: org.url,
        });
      });
      this.OrgList = newOrgsList;
    });
  }

  fetchRepos(org: string) {
    if (org) {
      let fetchListCall: Observable<any[]> = null;
      this.RepoList = [];
      this.BranchList = [];

      // This branch is to handle the differences between getting a users personal repos and getting repos for a specific org such as Azure
      // The API handles these differently but the UX shows them the same
      fetchListCall = org.toLocaleLowerCase().indexOf('github.com/users/') > -1 ? this._fetchUserRepos(org) : this._fetchOrgRepos(org);

      fetchListCall
        .switchMap(r => this._flattenResponses(r))
        .subscribe(
          r => this._loadRepositories(r),
          err => {
            this.reposLoading = false;
            this._logService.error(LogCategories.cicd, '/fetch-github-repos', err);
          }
        );
    }
  }

  fetchBranches(repo: string) {
    if (repo) {
      this.BranchList = [];
      this._githubService
        .fetchBranches(repo, this.repoUrlToNameMap[repo])
        .switchMap(r => {
          const linkHeader = r.headers.toJSON().link;
          const pageCalls: Observable<any>[] = [Observable.of(r)];
          if (linkHeader) {
            const links = ResponseHeader.getLinksFromLinkHeader(linkHeader);
            const lastPageNumber = this._getLastPage(links);
            for (let i = 2; i <= lastPageNumber; i++) {
              pageCalls.push(this._githubService.fetchBranches(repo, this.repoUrlToNameMap[repo], i));
            }
          }
          return Observable.forkJoin(pageCalls);
        })
        .switchMap(r => this._flattenResponses(r))
        .subscribe(
          r => this._loadBranches(r),
          err => {
            this._logService.error(LogCategories.cicd, '/fetch-github-branches', err);
            this.branchesLoading = false;
          }
        );
    }
  }

  updateFormValidation() {
    const required = new RequiredValidator(this._translateService, false);
    this.wizard.sourceSettings.get('repoUrl').setValidators(required.validate.bind(required));
    this.wizard.sourceSettings.get('branch').setValidators(required.validate.bind(required));
    this.wizard.sourceSettings.get('repoUrl').updateValueAndValidity();
    this.wizard.sourceSettings.get('branch').updateValueAndValidity();
  }

  RepoChanged(repo: DropDownElement<string>) {
    this.reposStream.next(repo.value);
    this.selectedBranch = '';
  }

  OrgChanged(org: DropDownElement<string>) {
    this.orgStream$.next(org.value);
    this.selectedRepo = '';
    this.selectedBranch = '';
  }

  private _loadBranches(responses: any[]) {
    const newBranchList: any[] = [];
    responses.forEach(branch => {
      newBranchList.push({
        displayLabel: branch.name,
        value: branch.name,
      });
    });

    this.BranchList = newBranchList;
    this.branchesLoading = false;
  }

  private _loadRepositories(responses: any[]) {
    const newRepoList: DropDownElement<string>[] = [];
    this.repoUrlToNameMap = {};
    responses
      .filter(repo => {
        return !repo.permissions || repo.permissions.admin;
      })
      .forEach(repo => {
        newRepoList.push({
          displayLabel: repo.name,
          value: repo.html_url,
        });
        this.repoUrlToNameMap[repo.html_url] = repo.full_name;
      });

    this.RepoList = newRepoList;
    this.reposLoading = false;
  }

  private _flattenResponses(responses: any[]) {
    let ret: any[] = [];
    responses.forEach(e => {
      ret = ret.concat(e.json());
    });
    return Observable.of(ret);
  }

  private _fetchUserRepos(org: string) {
    return this._githubService.fetchUserRepos(org).switchMap(r => {
      const linkHeader = r.headers.toJSON().link;
      const pageCalls: Observable<any>[] = [Observable.of(r)];
      if (linkHeader) {
        const links = ResponseHeader.getLinksFromLinkHeader(linkHeader);
        const lastPageNumber = this._getLastPage(links);
        for (let i = 2; i <= lastPageNumber; i++) {
          pageCalls.push(this._githubService.fetchUserRepos(org, i));
        }
      }
      return Observable.forkJoin(pageCalls);
    });
  }

  private _fetchOrgRepos(org: string) {
    return this._githubService.fetchOrgRepos(org).switchMap(r => {
      const linkHeader = r.headers.toJSON().link;
      const pageCalls: Observable<any>[] = [Observable.of(r)];
      if (linkHeader) {
        const links = ResponseHeader.getLinksFromLinkHeader(linkHeader);
        const lastPageNumber = this._getLastPage(links);
        for (let i = 2; i <= lastPageNumber; i++) {
          pageCalls.push(this._githubService.fetchOrgRepos(org, i));
        }
      }
      return Observable.forkJoin(pageCalls);
    });
  }

  private _getLastPage(links) {
    const lastPageLink = links && links.last;
    if (lastPageLink) {
      const lastPageNumber = +Url.getParameterByName(lastPageLink, 'page');
      return lastPageNumber;
    } else {
      return 1;
    }
  }
}
