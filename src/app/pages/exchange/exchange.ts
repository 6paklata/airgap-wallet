import { ExchangeSelectPage } from './../exchange-select/exchange-select.page'
import { ModalController, LoadingController } from '@ionic/angular'
import { Component } from '@angular/core'
import { Router } from '@angular/router'
import { AirGapMarketWallet, getProtocolByIdentifier, ICoinProtocol } from 'airgap-coin-lib'
import { BigNumber } from 'bignumber.js'

import { AccountProvider } from '../../services/account/account.provider'
import { DataService, DataServiceKey } from '../../services/data/data.service'
import { ExchangeProvider, ExchangeTransaction } from '../../services/exchange/exchange'
import { ErrorCategory, handleErrorSentry } from '../../services/sentry-error-handler/sentry-error-handler'
import { SettingsKey, StorageProvider } from '../../services/storage/storage'
import { ProtocolSymbols } from 'src/app/services/protocols/protocols'

enum ExchangePageState {
  LOADING,
  ONBOARDING,
  NOT_ENOUGH_CURRENCIES,
  EXCHANGE
}

@Component({
  selector: 'page-exchange',
  templateUrl: 'exchange.html',
  styleUrls: ['./exchange.scss']
})
export class ExchangePage {
  public selectedFromProtocol: ICoinProtocol
  public selectedToProtocol: ICoinProtocol
  public supportedProtocolsFrom: string[] = []
  public supportedProtocolsTo: string[] = []
  public fromWallet: AirGapMarketWallet
  public supportedFromWallets: AirGapMarketWallet[]
  public toWallet: AirGapMarketWallet
  public supportedToWallets: AirGapMarketWallet[]
  public amount: BigNumber = new BigNumber(0)
  public minExchangeAmount: BigNumber = new BigNumber(0)
  public exchangeAmount: BigNumber
  public activeExchange: string

  get isTZBTCExchange(): boolean {
    return (
      (this.selectedFromProtocol !== undefined && this.selectedFromProtocol.identifier === ProtocolSymbols.TZBTC) ||
      (this.selectedToProtocol !== undefined && this.selectedToProtocol.identifier === ProtocolSymbols.TZBTC)
    )
  }

  public exchangePageStates = ExchangePageState
  public exchangePageState: ExchangePageState = ExchangePageState.LOADING

  constructor(
    private readonly router: Router,
    private readonly exchangeProvider: ExchangeProvider,
    private readonly storageProvider: StorageProvider,
    private readonly accountProvider: AccountProvider,
    private readonly dataService: DataService,
    private readonly loadingController: LoadingController,

    private readonly modalController: ModalController
  ) {
    this.exchangeProvider.getActiveExchange().subscribe(exchange => {
      this.activeExchange = exchange
    })
  }

  public async ionViewWillEnter() {
    this.setup()
  }

  private filterValidProtocols(protocols: string[], filterZeroBalance: boolean = true): string[] {
    const walletList = this.accountProvider.getWalletList()
    const result = protocols.filter(supportedProtocol =>
      walletList.some(
        wallet =>
          wallet.protocolIdentifier === supportedProtocol &&
          (!filterZeroBalance || (filterZeroBalance && wallet.currentBalance.isGreaterThan(0)))
      )
    )
    const tzbtcIndex = result.indexOf(ProtocolSymbols.TZBTC)
    if (tzbtcIndex !== -1 && !walletList.some(wallet => wallet.protocolIdentifier === ProtocolSymbols.BTC)) {
      result.splice(tzbtcIndex, 1)
    }
    return result
  }

  private async setup() {
    const fromProtocols = await this.getSupportedFromProtocols()
    if (fromProtocols.length === 0) {
      this.supportedProtocolsFrom = []
      this.supportedProtocolsTo = []
      this.selectedFromProtocol = undefined
      this.selectedToProtocol = undefined
      this.exchangePageState = ExchangePageState.NOT_ENOUGH_CURRENCIES
      return
    }
    this.supportedProtocolsFrom = fromProtocols
    let currentFromProtocol: string
    if (this.selectedFromProtocol !== undefined && this.supportedProtocolsFrom.includes(this.selectedFromProtocol.identifier)) {
      currentFromProtocol = this.selectedFromProtocol.identifier
    } else {
      currentFromProtocol = fromProtocols[0]
    }
    await this.setFromProtocol(getProtocolByIdentifier(currentFromProtocol))

    if (this.exchangePageState === ExchangePageState.LOADING) {
      const hasShownOnboarding = await this.storageProvider.get(SettingsKey.EXCHANGE_INTEGRATION)
      if (!hasShownOnboarding) {
        this.exchangePageState = ExchangePageState.ONBOARDING
        return
      }
    }

    if (this.supportedProtocolsFrom.length > 0 && this.supportedProtocolsTo.length > 0) {
      this.exchangePageState = ExchangePageState.EXCHANGE
    }
  }

  private async getSupportedFromProtocols(): Promise<string[]> {
    const fromProtocols = await this.exchangeProvider.getAvailableFromCurrencies()
    fromProtocols.push(ProtocolSymbols.TZBTC)
    return this.filterValidProtocols(fromProtocols)
  }

  private async getSupportedToProtocols(from: string): Promise<string[]> {
    if (from === ProtocolSymbols.TZBTC) {
      return this.filterValidProtocols([ProtocolSymbols.BTC], false)
    }
    const toProtocols = await this.exchangeProvider.getAvailableToCurrenciesForCurrency(from)
    if (from === ProtocolSymbols.BTC) {
      toProtocols.push(ProtocolSymbols.TZBTC)
    }
    return this.filterValidProtocols(toProtocols, false)
  }

  async setFromProtocol(protocol: ICoinProtocol): Promise<void> {
    this.selectedFromProtocol = protocol
    this.supportedProtocolsTo = await this.getSupportedToProtocols(protocol.identifier)
    if (this.supportedProtocolsTo.length === 0) {
      this.supportedProtocolsFrom = []
      this.supportedProtocolsTo = []
      this.selectedFromProtocol = undefined
      this.selectedToProtocol = undefined
      this.exchangePageState = ExchangePageState.NOT_ENOUGH_CURRENCIES
      return
    }

    if (
      this.selectedToProtocol === undefined ||
      this.selectedFromProtocol.identifier === this.selectedToProtocol.identifier ||
      !this.supportedProtocolsTo.includes(this.selectedToProtocol.identifier)
    ) {
      const toProtocol = getProtocolByIdentifier(this.supportedProtocolsTo[0])
      this.selectedToProtocol = toProtocol
      this.loadWalletsForSelectedToProtocol()
    }

    this.loadWalletsForSelectedFromProtocol()
    this.loadDataFromExchange()
    // TODO: this is needed to update the amount in the portfolio-item component, need to find a better way to do this.
    this.accountProvider.triggerWalletChanged()
  }

  async setToProtocol(protocol: ICoinProtocol): Promise<void> {
    this.selectedToProtocol = protocol
    this.loadWalletsForSelectedToProtocol()
    this.loadDataFromExchange()
    // TODO: this is needed to update the amount in the portfolio-item component, need to find a better way to do this.
    this.accountProvider.triggerWalletChanged()
  }

  private loadWalletsForSelectedFromProtocol() {
    this.supportedFromWallets = this.walletsForProtocol(this.selectedFromProtocol.identifier, true)
    // Only set wallet if it's another protocol or not available
    if (this.shouldReplaceActiveWallet(this.fromWallet, this.supportedFromWallets)) {
      this.fromWallet = this.supportedFromWallets[0]
    }
  }

  private loadWalletsForSelectedToProtocol() {
    this.supportedToWallets = this.walletsForProtocol(this.selectedToProtocol.identifier, false)
    this.toWallet = this.supportedToWallets[0]
    // Only set wallet if it's another protocol or not available
    if (this.shouldReplaceActiveWallet(this.toWallet, this.supportedToWallets)) {
      this.toWallet = this.supportedToWallets[0]
    }
  }

  private walletsForProtocol(protocol: string, filterZeroBalance: boolean = true): AirGapMarketWallet[] {
    return this.accountProvider
      .getWalletList()
      .filter(wallet => wallet.protocolIdentifier === protocol && (!filterZeroBalance || wallet.currentBalance.isGreaterThan(0)))
  }

  private shouldReplaceActiveWallet(wallet: AirGapMarketWallet, walletArray: AirGapMarketWallet[]): boolean {
    return (
      !wallet ||
      wallet.protocolIdentifier !== walletArray[0].protocolIdentifier ||
      walletArray.every(supportedWallet => !this.accountProvider.isSameWallet(supportedWallet, wallet))
    )
  }

  async setFromWallet(wallet: AirGapMarketWallet) {
    this.fromWallet = wallet
    this.loadDataFromExchange()
    // TODO: this is needed to update the amount in the portfolio-item component, need to find a better way to do this.
    this.accountProvider.triggerWalletChanged()
  }

  async setToWallet(wallet: AirGapMarketWallet) {
    this.toWallet = wallet
    this.loadDataFromExchange()
    // TODO: this is needed to update the amount in the portfolio-item component, need to find a better way to do this.
    this.accountProvider.triggerWalletChanged()
  }

  async amountSet(amount: string) {
    this.amount = new BigNumber(amount)

    this.loadDataFromExchange()
  }

  private async loadDataFromExchange() {
    if (this.fromWallet && this.toWallet) {
      this.minExchangeAmount = await this.getMinAmountForCurrency()
    }
    if (this.fromWallet && this.toWallet && this.amount.isGreaterThan(0)) {
      this.exchangeAmount = new BigNumber(await this.getExchangeAmount())
    } else {
      this.exchangeAmount = new BigNumber(0)
    }
  }

  private async getMinAmountForCurrency(): Promise<BigNumber> {
    if (this.isTZBTCExchange) {
      return new BigNumber(0)
    }
    return new BigNumber(
      await this.exchangeProvider.getMinAmountForCurrency(this.fromWallet.protocolIdentifier, this.toWallet.protocolIdentifier)
    )
  }

  private async getExchangeAmount(): Promise<string> {
    if (this.isTZBTCExchange) {
      return this.amount.toFixed()
    }
    return await this.exchangeProvider.getExchangeAmount(
      this.fromWallet.protocolIdentifier,
      this.toWallet.protocolIdentifier,
      this.amount.toString()
    )
  }

  async startExchange() {
    if (this.isTZBTCExchange) {
      this.router.navigateByUrl('/exchange-custom').catch(handleErrorSentry(ErrorCategory.STORAGE))
    } else {
      const loader = await this.getAndShowLoader()
      try {
        const result = await this.exchangeProvider.createTransaction(
          this.fromWallet.protocolIdentifier,
          this.toWallet.protocolIdentifier,
          this.toWallet.receivingPublicAddress,
          this.amount.toString()
        )

        const amountExpectedTo = await this.getExchangeAmount()
        const info = {
          fromWallet: this.fromWallet,
          fromCurrency: this.fromWallet.protocolIdentifier,
          toWallet: this.toWallet,
          toCurrency: this.exchangeProvider.convertAirGapIdentifierToExchangeIdentifier([this.toWallet.protocolIdentifier])[0],
          exchangeResult: result,
          amountExpectedFrom: this.amount.toString(),
          amountExpectedTo: amountExpectedTo
        }

        this.dataService.setData(DataServiceKey.EXCHANGE, info)
        this.router.navigateByUrl('/exchange-confirm/' + DataServiceKey.EXCHANGE).catch(handleErrorSentry(ErrorCategory.STORAGE))

        const txId = result.id
        let txStatus: string = (await this.exchangeProvider.getStatus(txId)).status

        const exchangeTxInfo = {
          receivingAddress: this.toWallet.addresses[0],
          sendingAddress: this.fromWallet.addresses[0],
          fromCurrency: this.fromWallet.protocolIdentifier,
          toCurrency: this.toWallet.protocolIdentifier,
          amountExpectedFrom: this.amount,
          amountExpectedTo: amountExpectedTo.toString(),
          status: txStatus,
          exchange: this.activeExchange,
          id: txId,
          timestamp: new BigNumber(Date.now()).toNumber()
        } as ExchangeTransaction

        this.exchangeProvider.pushExchangeTransaction(exchangeTxInfo)
      } catch (error) {
        console.error(error)
      } finally {
        this.hideLoader(loader)
      }
    }
  }

  async doRadio(): Promise<void> {
    const modal: HTMLIonModalElement = await this.modalController.create({
      component: ExchangeSelectPage,
      componentProps: {
        activeExchange: this.activeExchange
      }
    })

    modal.present().catch(err => console.error(err))

    modal
      .onDidDismiss()
      .then(async () => {
        await this.setup()
      })
      .catch(handleErrorSentry(ErrorCategory.IONIC_MODAL))
  }

  dismissExchangeOnboarding() {
    this.setup()
    this.storageProvider.set(SettingsKey.EXCHANGE_INTEGRATION, true).catch(handleErrorSentry(ErrorCategory.STORAGE))
  }

  goToAddCoinPage() {
    this.router.navigateByUrl('/account-add')
  }

  private async getAndShowLoader() {
    const loader = await this.loadingController.create({
      message: 'Preparing transaction...'
    })

    await loader.present().catch(handleErrorSentry(ErrorCategory.IONIC_LOADER))

    return loader
  }

  private hideLoader(loader: HTMLIonLoadingElement) {
    loader.dismiss().catch(handleErrorSentry(ErrorCategory.IONIC_LOADER))
  }
}
