@import 'ui.js'

// https://developer.apple.com/reference/quartz/pdfdocument
// https://developer.apple.com/reference/quartz/pdfpage

// TODO: Nested symbols
// TODO: Sorting
// TODO: Image export @2x
// TODO: GUI - settings/preferences

/*

SETTINGS:
* artboards (all pages, current page, or selection)
* order (left to right/top to bottom, top to bottom/left to right, layer list, layerlist reversed, selection order)
* Include/ignore symbols
* Export as images vs native PDF
* Export image size - 1x, 2x, 3x
* Exclude artboards with prefix

*/

// Global initalised variables from 'context'
var doc
var selection
var iconImage

// preferences
var exportToImages = false
var excludeWithPrefix = true
var exclusionPrefix = '-'
var imageExportScale = 3
// 'left-right-top-bottom', 'top-bottom-left-right', 'layer-list', 'layer-list-reversed', 'selection'
var order = 'left-right-top-bottom'


function initialise(context) {
  doc = context.document
  selection = context.selection
  iconImage = NSImage.alloc().initByReferencingFile(context.plugin.urlForResourceNamed("icon.png").path())
}

// ****************************
//         Handlers
// ****************************

function exportCurrentPage(context) {
  initialise(context)
  showOptionsWindow()

  return
  exportArtboards(doc.currentPage().artboards(), doc.currentPage().name())
}

function exportAllPages(context) {
  initialise(context)

  var artboards = []
  doc.pages().forEach(page => {
    // Ignore pages with the prefix
    if (excludeWithPrefix && page.name().startsWith(exclusionPrefix))
      return

    page.artboards().forEach(artboard => {
      print(artboard.name())
      artboards.push(artboard)
    })
  })

  exportArtboards(artboards, doc.publisherFileName())
}


function exportSelection(context) {
  initialise(context)

  order = 'selection'

  // If any of the selection is not an artboard — then return
  // Filter out the bad layers — only allow MSArtboardGroup or MSSymbolMaster
  var validLayers = true
  selection.forEach(layer => {
    if (!(layer.isMemberOfClass(MSArtboardGroup) || layer.isMemberOfClass(MSSymbolMaster))) {
      validLayers = false
      return
    }
  })

  if (validLayers && selection.count() > 0) {
    exportArtboards(selection, selection.firstObject().name())
  } else {
    // TODO: Make an actual dialog
    doc.showMessage("Only artboards allowed to proceed PDF export")
  }
}


// ****************************
//      Organising Artboards
// ****************************

// Export the given artboards — based on the user's preferences
// This includes exporting as images, and the order the artboards are sorted
function exportArtboards(artboards, outputName) {
  // Collate them into a single page
  collateArtboardsIntoPage(artboards, outputName, collatedPage => {
    if (exportToImages) {
      exportPageToImagesToPDF(collatedPage)
    } else {
      exportPageToPDF(collatedPage)
    }
  })
}

// Takes an array of artboards — and will return a single page with them all on it
// The artboards will be sorted according to the specified settings
// 'callback' will return the page, containing a collation of the artboards
function collateArtboardsIntoPage(artboards, outputName, callback) {

  // Let's create a new page
  var temporaryPage = MSPage.new()
  // TODO: Add some more smarts around what the name is
  var name = NSUUID.UUID().UUIDString()
  name = cleanString(outputName)
  temporaryPage.setName(name)

  // Add the page to our document, temporarily (we'll remove it later)
  doc.documentData().addPage(temporaryPage)

  // Filter artboards if necessary
  if (excludeWithPrefix) {
    artboards = filter(artboards, artboard => {
      return !artboard.name().startsWith(exclusionPrefix)
    })
  }

  // Sort the artboards — either by visual location, layer list order, or selection order
  print(order)
  switch (order) {
    case 'left-right-top-bottom':
      print('sort: lrtb')
      artboards = artboards.sort((a, b) => {
        return a.frame().top() < b.frame().top()
      }).sort((a, b) => {
        return a.frame().left() < b.frame().left()
      })
      // artboards = artboards.sort(sortLeftRightTopBottom)
      break
    case 'top-bottom-left-right':
      print('sort: tblr')
      artboards = artboards.sort(sortTopBottomLeftRight)
      break
    default: break
  }


  // Add all the artboards to the page
  artboards.forEach(artboard => {
    let copy = artboard.copy()

    // If the layer is a MSSymbolMaster — convert it to an artboard
    if (copy.isMemberOfClass(MSSymbolMaster)) {
      copy = MSSymbolMaster.convertSymbolToArtboard(copy)
    }
    temporaryPage.addLayer(copy)
  })

  var x = 0
  temporaryPage.children().forEach(pageLayer => {
    // Detatch any instances of symbols (including any sub-symbols)
    if (pageLayer.isMemberOfClass(MSSymbolInstance)) {
      findAndDetachFromSymbol(pageLayer)
    }
    // Lay them out nicely (without overlap)
    if (pageLayer.isMemberOfClass(MSArtboardGroup)) {
      pageLayer.frame().setX(x)
      pageLayer.frame().setY(0)
      x += (pageLayer.frame().width() + 1)
    }
  })

  function findAndDetachFromSymbol(layer) {
    if (layer.isMemberOfClass(MSSymbolInstance)) {
      layer = layer.detachByReplacingWithGroup()
      layer.children().forEach(innerLayer => {
        findAndDetachFromSymbol(innerLayer)
      })
    }
  }

  // Return the page pack to the callback
  callback(temporaryPage)

  // Remove the temporary page now that we are done with it
  doc.documentData().removePage(temporaryPage)
}


// ****************************
//      Sorting
// ****************************

function sortLeftRightTopBottom(a, b){
	var x = a.frame().left() - b.frame().left()
  return x == 0 ? a.frame().top() - b.frame().top() : x
}

function sortTopBottomLeftRight(a, b){
	var x = a.frame().top() - b.frame().top()
  return x == 0 ? a.frame().left() - b.frame().left() : x
}


// ****************************
//      PDF Exporting
// ****************************

// Export page by the built-in exporter
// This also automatically asks the user where they want to save it
function exportPageToPDF(page) {
  // Export the temporary page to the PDF
  // var artboard = page.artboards().firstObject()
  // MSPDFBookExporter.pdfFromArtboard(artboard)
  MSPDFBookExporter.exportPages_defaultFilename([page], page.name())
}

// Allow exporting PDFs as images
function exportPageToImagesToPDF(page) {

  // Ask the user where they want to save it
  var fileURL = promptSaveLocation(page.name())
  if (!fileURL) return // If they cancel — return

  // Create a new PDF document
  var pdf = PDFDocument.alloc().init()
  // Let's keep a reference to all the temporary images we create to build up our PDF
  // So that we can delete them later
  var filePaths = []

  // For each artboard, turn it into an image and add that to our PDF
  page.children().forEach(artboard => {
    if (!artboard.isMemberOfClass(MSArtboardGroup))
      return

    if (artboard.hasBackgroundColor() && artboard.includeBackgroundColorInExport()) {
      var shape = MSShapeGroup.shapeWithRect(artboard.bounds())
      var fill = shape.style().addStylePartOfType(0)
      fill.color = artboard.backgroundColor()
      artboard.insertLayers_atIndex([shape], 0)
    }

    // Create a temporary image of the artboard
    var random = NSUUID.UUID().UUIDString()
    var tempPath = NSTemporaryDirectory() + artboard.objectID() + ' ' + random + '.png'
    // doc.saveArtboardOrSlice_toFile(tempSlice, tempPath)
    filePaths.push(tempPath)

    // [[layer exportOptions] addExportFormat]
    artboard.exportOptions().addExportFormat()
    var exportSize = artboard.exportOptions().exportFormats().lastObject() //[[[layer exportOptions] exportFormats] lastObject]
    exportSize.scale = imageExportScale
    exportSize.name = ''
    exportSize.format = 'png'

    var rect = artboard.absoluteRect().rect()
    var slice = MSExportRequest.exportRequestFromExportFormat_layer_inRect_useIDForName(exportSize, artboard, rect, false)
    doc.saveArtboardOrSlice_toFile(slice, tempPath)

    // Add the image as a page to our PDF
    var image = NSImage.alloc().initByReferencingFile(tempPath)
    var pdfPage = PDFPage.alloc().initWithImage(image)
    pdf.insertPage_atIndex(pdfPage, pdf.pageCount())
  })

  // Save the whole PDF document — to the location the user specified
  pdf.writeToURL(fileURL)

  // Delete each of the temporary images we created for the artboards
  filePaths.forEach(filePath => {
    NSFileManager.defaultManager().removeItemAtPath_error(filePath, nil)
  })
}


// ****************************
//      Helper functions
// ****************************

// Present a dialog to prompt the user to select the location to save the file
// 'filename' is the placeholder file name for the prompt
function promptSaveLocation(fileName) {

  var saveDialog = NSSavePanel.savePanel()
  saveDialog.setNameFieldStringValue(fileName)
  saveDialog.setAllowedFileTypes(["pdf"])

  // If the users selects 'OK', return the location they specified
  if (saveDialog.runModal() == NSOKButton)
    return saveDialog.URL()
  // Otherwise return nothing
  return nil
}

// Given an array, an a 'condition' function, that returns a boolean
// The condition should return true if it should keep the element in the array
// Will return the array filtered
function filter(array, condition) {
  var filteredArray = []
  array.forEach(e => {
    if (condition(e))
      filteredArray.push(e)
  })
  return filteredArray
}

function cleanString(string){
  var notAllowedChars = NSCharacterSet.characterSetWithCharactersInString("\\<>=,!#$&'()*+/:;=?@[]%")
  return string.componentsSeparatedByCharactersInSet(notAllowedChars).componentsJoinedByString('')
}

//
// function findAndDetachFromSymbol(layer) {
//   print("Checking layer: " + layer.name())
//   if (layer.isMemberOfClass(MSSymbolInstance.class())) {
//     layer = layer.detachByReplacingWithGroup()
//   } else if (layer.isMemberOfClass(MSLayerGroup.class())){
//     print("check children")
//     print(layer.children())
//     // layer.children().forEach(child => findAndDetachFromSymbol(child))
//   }
// }







/*


function currentPageToPDF(context) {
    pageToPDF(context.document.currentPage())
}

function selectedArtboardsToPDF(context) {
    var doc = context.document
    var selection = context.selection

    if (selection.count() <= 0) {
        print(selection)
        document.showMessage("Please select any artboards to proceed")
        return
    }

    var tempPage = MSPage.new()
    doc.documentData().addPage(tempPage)
    tempPage.setName("PDF Export")

    var selectionLoop = selection.objectEnumerator()
    var selectedArtboards = NSMutableArray.array()
    while (layer = selectionLoop.nextObject()) {
        if (layer.isMemberOfClass(MSArtboardGroup)) {
            selectedArtboards.addObject(layer.copy())
        } else if (layer.isMemberOfClass(MSSymbolMaster)) {
            var layerCopy = MSSymbolMaster.convertSymbolToArtboard(layer.copy())
            selectedArtboards.addObject(layerCopy)
        } else {
            doc.showMessage("Only artboards allowed to proceed PDF export")
            return
        }
    }
    tempPage.addLayers(selectedArtboards)

    var pageChildrenLoop = tempPage.children().objectEnumerator()
    while (pageLayer = pageChildrenLoop.nextObject()) {
        if (pageLayer.isMemberOfClass(MSSymbolInstance)) {
            findAndDetachFromSymbol(pageLayer)
        }
    }
    function findAndDetachFromSymbol(layer) {
        if (layer.isMemberOfClass(MSSymbolInstance)) {
            layer = layer.detachByReplacingWithGroup()
            var layerChildrenLoop = layer.children().objectEnumerator()
            while (innerLayer = layerChildrenLoop.nextObject()) {
                findAndDetachFromSymbol(innerLayer)
            }
        }
    }

    pageToPDF(tempPage)
    doc.documentData().removePage(tempPage)
}

function allPagesToPDF(context) {
	var doc = context.document
	doc.exportPDFBook(doc)
}

function pageToPDF(page) {
    var pageArray = [page]
    MSPDFBookExporter.exportPages_defaultFilename(pageArray, page.name() + ".pdf")
}
*/
